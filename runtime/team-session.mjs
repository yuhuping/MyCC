import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { runAgent } from './agent.mjs'
import { TeamStore } from './team-store.mjs'
import { createTeamTools } from './team-tools.mjs'
import { createTeamWorktree, removeTeamWorktree, captureTeamPatch, checkpointTeamWorktree, applyTeamPatch } from './team-worktree.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeName = value => String(value || 'teammate').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || `teammate-${randomUUID().slice(0, 8)}`

export class TeamSession extends EventEmitter {
  constructor({ workspace, provider, model, teamName = 'mycc-team', maxTeammates = 4, maxTurns = null, teammateMaxTurns = 8, permissions = [], permissionMode = 'default', hooks = {}, contextWindow = null, budgetTokens = null, sessionDir = null, resumeSessionId = null, sessionId = null, onPermissionRequest = null, onEvent = () => {}, signal = null } = {}) {
    super()
    this.workspace = path.resolve(workspace)
    this.provider = provider
    this.model = model
    this.maxTeammates = Math.max(1, Math.min(8, maxTeammates))
    this.maxTurns = maxTurns
    this.teammateMaxTurns = teammateMaxTurns
    if (resumeSessionId) throw new Error('Team sessions do not support resume; start a new --team session')
    this.leadOptions = { permissions, permissionMode, hooks, contextWindow, budgetTokens, sessionDir, sessionId, onPermissionRequest, preserveIndex: true }
    this.teammateOptions = { permissions, permissionMode, hooks, contextWindow, budgetTokens, onPermissionRequest }
    this.onEvent = event => { onEvent(event); this.emit('event', event) }
    this.store = new TeamStore({ workspace: this.workspace, teamName })
    this.store.on('change', revision => this.emit('revision', revision))
    this.memberControllers = new Map()
    this.memberRuns = new Map()
    this.leadHistory = []
    this.teamCreated = false
    this.aborted = false
    this.signal = signal
    signal?.addEventListener('abort', () => this.abort(), { once: true })
  }

  async ensureStore() { return await this.store.init() }

  requireTeam() {
    if (!this.teamCreated || !this.store.state || this.store.state.stopped) throw new Error('Create a team with TeamCreate before using team tools')
  }

  async createTeam(input = {}) {
    if (!this.store.state && input.team_name) this.store.setTeamName(input.team_name)
    await this.ensureStore()
    if (this.store.state.stopped) throw new Error('Team has already been deleted')
    this.teamCreated = true
    // TeamCreate only establishes the named team. Every teammate must be
    // explicitly started by the built-in Agent background path.
    const members = []
    const teamId = this.store.state.teamId
    this.onEvent({ type: 'team_created', teamId, members: members.map(member => member.name) })
    return this.summary()
  }

  async spawnTeammate(input = {}) {
    this.requireTeam()
    if (!input.team_name) throw new Error('Team Agent requires team_name')
    if (!input.name) throw new Error('Team Agent requires name')
    if (safeName(input.team_name) !== this.store.state.teamName) throw new Error(`Agent team_name ${input.team_name} does not match active team ${this.store.state.teamName}`)
    const count = Object.values(this.store.state.members).filter(member => member.role === 'teammate').length
    if (count >= this.maxTeammates) throw new Error(`Team has reached max_teammates (${this.maxTeammates})`)
    const name = safeName(input.name ?? `teammate-${count + 1}`)
    if (this.store.state.members[name]) throw new Error(`Team member already exists: ${name}`)
    const worktreePath = path.join(this.store.teamDir, 'worktrees', name)
    const worktree = await createTeamWorktree({ workspace: this.workspace, worktreePath })
    const syncedPatchIds = Object.values(this.store.state.tasks).filter(task => task.patchStatus === 'applied').map(task => String(task.id))
    await this.store.addMember({ name, workspace: worktree.path, baseRevision: worktree.baseRevision, syncedPatchIds, prompt: input.prompt ?? '', model: input.model ?? this.model, maxTurns: input.maxTurns ?? this.teammateMaxTurns })
    this.startMember(name, input.prompt ?? `You are teammate ${name}. Work on assigned team tasks.`)
    this.onEvent({ type: 'teammate_spawned', name })
    return { name, workspace: worktree.path, status: 'active' }
  }

  startMember(name, initialPrompt) {
    const controller = new AbortController()
    this.memberControllers.set(name, controller)
    const promise = this.memberLoop(name, initialPrompt, controller.signal).catch(error => {
      this.onEvent({ type: 'teammate_error', name, error: error instanceof Error ? error.message : String(error) })
      return null
    })
    this.memberRuns.set(name, promise)
    return promise
  }

  async nextMessage(name) {
    while (!this.aborted && !this.memberControllers.get(name)?.signal.aborted) {
      const shutdown = await this.store.consumeMessage(name, message => message.type === 'shutdown_request')
      if (shutdown) return shutdown
      // Lead messages outrank peer messages; both retain FIFO order within source.
      const lead = await this.store.consumeMessage(name, message => message.from === 'lead')
      if (lead) return lead
      const peer = await this.store.consumeMessage(name, message => message.from !== 'lead')
      if (peer) return peer
      const task = await this.store.claimNextTask(name)
      if (task) return { type: 'task', task }
      await sleep(100)
    }
    return null
  }

  async syncAppliedPatches(name) {
    const member = this.store.state.members[name]
    if (!member) return true
    for (const task of Object.values(this.store.state.tasks)) {
      if (task.patchStatus !== 'applied' || !task.patch?.path || task.owner === name || member.syncedPatchIds?.includes(String(task.id))) continue
      const patchResult = await applyTeamPatch({ workspace: member.workspace, patchPath: task.patch.path })
      if (!patchResult.ok) {
        await this.store.sendMessage({ from: 'lead', to: name, type: 'blocker', content: `Could not synchronize applied task ${task.id}: ${patchResult.detail}` })
        return false
      }
      const baseRevision = await checkpointTeamWorktree({ worktreePath: member.workspace, message: `sync team patch ${task.id}` })
      await this.store.setMember(name, { baseRevision, syncedPatchIds: [...new Set([...(member.syncedPatchIds ?? []), String(task.id)])] })
    }
    return true
  }

  async memberLoop(name, initialPrompt, signal) {
    const member = this.store.state.members[name]
    let messages = []
    let firstTurn = true
    while (!signal.aborted && !this.aborted) {
      if (!await this.syncAppliedPatches(name)) { await sleep(100); continue }
      const next = firstTurn && initialPrompt ? { type: 'startup', content: initialPrompt } : await this.nextMessage(name)
      firstTurn = false
      if (!next) break
      if (next.type === 'shutdown_request') {
        await this.store.sendMessage({ from: name, to: 'lead', type: 'shutdown_response', content: 'shutdown_approved', requestId: next.requestId })
        break
      }
      const prompt = `You are a MyCC Agent Team teammate. Your plain text is private to the team and is not shown to the user; communicate findings with SendMessage. Never create/delete/spawn a nested team. Complete assigned work and call TaskUpdate(status=completed) only after the worktree patch is ready.\n\n${next.type === 'task'
        ? `[Team task ${next.task.id}] ${next.task.subject}\n${next.task.description}\nYou own this task.`
        : next.content}`
      this.onEvent({ type: 'teammate_turn_start', name, kind: next.type })
      try {
        const result = await runAgent({
          prompt, workspace: member.workspace, messages, model: member.model ?? this.model,
          provider: this.provider, maxTurns: member.maxTurns ?? this.teammateMaxTurns, signal,
          extraTools: createTeamTools(this, name),
          ...this.teammateOptions,
          onEvent: event => this.onEvent({ ...event, teammate: name }),
        })
        messages = result.messages
        await this.store.sendMessage({ from: name, to: 'lead', type: 'idle_notification', content: result.finalText || 'idle' })
        this.onEvent({ type: 'teammate_idle', name, text: result.finalText || '' })
      } catch (error) {
        await this.store.sendMessage({ from: name, to: 'lead', type: 'blocker', content: error instanceof Error ? error.message : String(error) })
        this.onEvent({ type: 'teammate_error', name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await this.store.setMember(name, { status: 'stopped' }).catch(() => {})
    this.onEvent({ type: 'teammate_stopped', name })
  }

  async createTask(input = {}) {
    this.requireTeam()
    const { actor = 'lead', ...taskInput } = input
    if (taskInput.owner && !this.store.state.members[taskInput.owner]) throw new Error(`Unknown task owner: ${taskInput.owner}`)
    const task = await this.store.addTask(taskInput)
    if (task.owner && task.status !== 'completed') await this.store.sendMessage({ from: actor, to: task.owner, type: 'task_revision', content: `Task ${task.id} is assigned to you.` })
    return task
  }
  async getTask({ id }) { this.requireTeam(); if (!id) throw new Error('TaskGet requires task_id'); return await this.store.getTask(id) }
  async listTasks() { this.requireTeam(); return await this.store.listTasks() }

  async updateTask({ id, actor, status, ...updates }) {
    this.requireTeam()
    if (!id) throw new Error('TaskUpdate requires task_id')
    const before = await this.store.getTask(id)
    if (!before) throw new Error(`Unknown task: ${id}`)
    if (status === 'completed' && before.owner && before.owner !== actor) throw new Error(`Only task owner ${before.owner} can complete task ${id}`)
    const patchUpdates = { ...updates }
    delete patchUpdates.task_id
    if (patchUpdates.owner && !this.store.state.members[patchUpdates.owner]) throw new Error(`Unknown task owner: ${patchUpdates.owner}`)
    if (status) patchUpdates.status = status
    if (patchUpdates.status === 'completed' && before.owner === actor && actor !== 'lead') {
      const member = this.store.state.members[actor]
      const patchPath = path.join(this.store.teamDir, 'patches', `task-${id}.patch`)
      try {
        const patch = await captureTeamPatch({ worktreePath: member.workspace, baseRevision: member.baseRevision, patchPath })
        const checkpoint = await checkpointTeamWorktree({ worktreePath: member.workspace, message: `complete team task ${id}` })
        await this.store.setMember(actor, { baseRevision: checkpoint, syncedPatchIds: member.syncedPatchIds ?? [] })
        const completed = await this.store.updateTask(id, { ...patchUpdates, checkpoint, patch: { ...patch, path: patchPath }, patchStatus: patch.bytes ? 'pending' : 'none' })
        await this.store.sendMessage({ from: actor, to: 'lead', type: 'task_revision', content: `Task ${id} completed; patch ${patch.bytes ? 'pending application' : 'empty'}` })
        return completed
      } catch (error) {
        throw new Error(`Task ${id} completion could not capture patch; task remains in_progress: ${error.message}`)
      }
    }
    const task = await this.store.updateTask(id, patchUpdates)
    if (task.owner && task.status !== 'completed' && (task.owner !== before.owner || task.status !== before.status)) {
      await this.store.sendMessage({ from: actor, to: task.owner, type: 'task_revision', content: `Task ${task.id} was updated and is ready.` })
    }
    return task
  }

  async sendMessage({ actor, to, type = 'message', content = '', summary = null, request_id: requestId = null }) {
    this.requireTeam()
    if (!to) throw new Error('SendMessage requires recipient')
    if (to !== '*' && !this.store.state.members[to]) throw new Error(`Unknown team recipient: ${to}`)
    const message = await this.store.sendMessage({ from: actor, to, type, content, summary, requestId })
    this.onEvent({ type: 'team_message', message })
    return message
  }

  async applyPatch({ id, actor = 'lead' }) {
    this.requireTeam()
    if (actor !== 'lead') throw new Error('Only the lead can apply team patches')
    if (!id) throw new Error('TeamApplyPatch requires task_id')
    const task = await this.store.getTask(id)
    if (!task) throw new Error(`Unknown task: ${id}`)
    if (task.patchStatus === 'applied' || task.patchStatus === 'none') return task
    if (!task.patch?.path) throw new Error(`Task ${id} has no patch`)
    const result = await applyTeamPatch({ workspace: this.workspace, patchPath: task.patch.path })
    if (!result.ok) return { ok: false, taskId: String(id), reason: result.reason, detail: result.detail, task }
    return await this.store.updateTask(id, { patchStatus: 'applied' })
  }

  async deleteTeam() {
    this.requireTeam()
    if (!await this.store.allTasksComplete()) throw new Error('TeamDelete requires all tasks completed and patches applied')
    // A normal shutdown is an inbox message: a teammate finishes its current
    // run, consumes the request, and responds. Only an external abort kills it.
    for (const name of this.memberControllers.keys()) {
      if (this.store.state.members[name]?.status === 'stopped') continue
      await this.store.sendMessage({ from: 'lead', to: name, type: 'shutdown_request', content: 'Please stop.' })
    }
    await Promise.all([...this.memberRuns.values()])
    const results = []
    for (const member of Object.values(this.store.state.members)) {
      if (member.role !== 'teammate') continue
      results.push(await removeTeamWorktree({ workspace: this.workspace, worktreePath: member.workspace }))
    }
    if (results.some(result => !result.ok)) throw new Error(`TeamDelete could not remove all worktrees: ${results.filter(result => !result.ok).map(result => result.reason).join('; ')}`)
    await this.store.mutate(state => { state.stopped = true; for (const member of Object.values(state.members)) member.status = 'stopped' })
    // Keep the in-memory summary for the caller, but remove persistent team
    // state so a later TeamCreate with the same name starts fresh.
    await fs.rm(this.store.teamDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    await fs.rm(this.store.taskDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    this.teamCreated = false
    this.onEvent({ type: 'team_deleted' })
    return this.summary()
  }

  async waitForLeadMessage() {
    while (!this.aborted && !this.store.state.stopped) {
      const message = await this.store.consumeMessage('lead')
      if (message) return message
      await sleep(100)
    }
    return null
  }

  async run(prompt) {
    let result = await this.runLeadTurn(prompt, this.leadHistory)
    this.leadHistory = result.messages
    let leadTurns = result.turns
    while (!this.aborted && !this.store.state?.stopped && (this.maxTurns == null || leadTurns < this.maxTurns)) {
      if (!Object.values(this.store.state?.members ?? {}).some(member => member.role === 'teammate' && member.status !== 'stopped')) break
      const message = await this.waitForLeadMessage()
      if (!message) break
      const inbox = `[Team inbox from ${message.from}, ${message.type}]\n${message.content}`
      result = await this.runLeadTurn(inbox, result.messages, this.maxTurns == null ? null : Math.max(1, this.maxTurns - leadTurns))
      this.leadHistory = result.messages
      leadTurns += result.turns
    }
    return { ...result, team: this.summary() }
  }

  async runLeadTurn(prompt, messages, maxTurns = this.maxTurns) {
    const workflow = 'You are the lead of a MyCC Agent Team. Use TeamCreate once, then Agent({team_name,name,prompt,run_in_background:true}) for teammates. Track work with TaskCreate/List/Get/Update; teammates communicate only via SendMessage. Apply completed patches with TeamApplyPatch before TeamDelete.\n\n'
    return await runAgent({ prompt: messages.length ? prompt : workflow + prompt, workspace: this.workspace, messages, model: this.model, provider: this.provider, maxTurns, signal: this.signal, extraTools: createTeamTools(this, 'lead'), agentTeamRunner: options => this.spawnTeammate(options), ...this.leadOptions, onEvent: event => this.onEvent({ ...event, teammate: 'lead' }) })
  }

  abort() {
    this.aborted = true
    for (const controller of this.memberControllers.values()) controller.abort()
  }

  summary() {
    const state = this.store.state ?? { teamId: null, teamName: null, stopped: false, members: {}, tasks: {}, messages: [], revision: 0 }
    return {
      teamId: state.teamId, teamName: state.teamName, stopped: state.stopped,
      members: Object.values(state.members).map(member => ({ name: member.name, role: member.role, status: member.status, workspace: member.workspace })),
      tasks: Object.values(state.tasks), pendingMessages: state.messages.length, revision: state.revision,
    }
  }
}

export async function runTeam(options) { return await new TeamSession(options).run(options.prompt) }
