import { promises as fs } from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const NO_CHANGE = Symbol('no-change')

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await fs.rename(temporary, file)
}

function now() { return new Date().toISOString() }

export class TeamStore extends EventEmitter {
  constructor({ workspace, teamName = 'mycc-team', statePath = null } = {}) {
    super()
    this.workspace = path.resolve(workspace)
    this.teamName = String(teamName).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'mycc-team'
    this.teamDir = path.join(this.workspace, '.mycc', 'teams', this.teamName)
    this.inboxDir = path.join(this.teamDir, 'inboxes')
    this.taskDir = path.join(this.workspace, '.mycc', 'tasks', this.teamName)
    this.statePath = statePath ? path.resolve(statePath) : path.join(this.teamDir, 'config.json')
    this.state = null
    this.lock = Promise.resolve()
  }

  async init({ lead = 'lead', teamId = randomUUID() } = {}) {
    try {
      this.state = JSON.parse(await fs.readFile(this.statePath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.state = {
        version: 1, teamId, teamName: this.teamName, workspace: this.workspace, lead,
        revision: 0, members: {}, tasks: {}, messages: [], patches: {}, stopped: false,
      }
      this.state.members[lead] = { name: lead, role: 'lead', status: 'active', workspace: this.workspace }
      await this.persist()
    }
    return this.state
  }

  setTeamName(teamName) {
    if (this.state) return
    this.teamName = String(teamName).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'mycc-team'
    this.teamDir = path.join(this.workspace, '.mycc', 'teams', this.teamName)
    this.inboxDir = path.join(this.teamDir, 'inboxes')
    this.taskDir = path.join(this.workspace, '.mycc', 'tasks', this.teamName)
    this.statePath = path.join(this.teamDir, 'config.json')
  }

  async ensure() { if (!this.state) await this.init(); return this.state }

  async persist() {
    await atomicWrite(this.statePath, this.state)
    await atomicWrite(path.join(this.taskDir, 'tasks.json'), this.state.tasks)
    const recipients = new Set(['lead', ...Object.keys(this.state.members)])
    for (const recipient of recipients) {
      await atomicWrite(path.join(this.inboxDir, `${recipient}.json`), this.state.messages.filter(message => message.to === recipient || message.to === '*'))
    }
  }

  async mutate(fn) {
    const previous = this.lock
    let release
    this.lock = new Promise(resolve => { release = resolve })
    await previous
    try {
      await this.ensure()
      const result = await fn(this.state)
      if (result === NO_CHANGE) return null
      this.state.revision++
      await this.persist()
      this.emit('change', this.state.revision)
      return result
    } finally { release() }
  }

  snapshot() { return structuredClone(this.state) }

  async addMember(member) {
    return this.mutate(state => {
      if (state.members[member.name]) throw new Error(`Team member already exists: ${member.name}`)
      state.members[member.name] = { name: member.name, role: 'teammate', status: 'active', ...member }
      return state.members[member.name]
    })
  }

  async setMember(name, updates) {
    return this.mutate(state => {
      if (!state.members[name]) throw new Error(`Unknown team member: ${name}`)
      Object.assign(state.members[name], updates)
      return state.members[name]
    })
  }

  async addTask(task) {
    return this.mutate(state => {
      const id = String(task.id ?? Math.max(0, ...Object.keys(state.tasks).map(Number).filter(Number.isFinite), 0) + 1)
      if (state.tasks[id]) throw new Error(`Task already exists: ${id}`)
      state.tasks[id] = {
        id, subject: task.subject ?? task.title ?? '', description: task.description ?? '',
        status: task.status ?? 'pending', owner: task.owner ?? null,
        blockedBy: [...(task.blockedBy ?? task.dependencies ?? [])].map(String),
        checkpoint: task.checkpoint ?? null, patch: null, patchStatus: 'none',
        createdAt: now(), updatedAt: now(), ...task, id, revision: 0,
      }
      return structuredClone(state.tasks[id])
    })
  }

  async getTask(id) { await this.ensure(); return this.state.tasks[String(id)] ? structuredClone(this.state.tasks[String(id)]) : null }
  async listTasks() { await this.ensure(); return Object.values(this.state.tasks).map(task => structuredClone(task)) }

  async claimTask(id, owner) {
    return this.mutate(state => {
      const task = state.tasks[String(id)]
      if (!task) throw new Error(`Unknown task: ${id}`)
      if (task.status !== 'pending' || (task.owner && task.owner !== owner)) return NO_CHANGE
      if (Object.values(state.tasks).some(other => other.owner === owner && other.status === 'in_progress')) return NO_CHANGE
      const blockers = task.blockedBy ?? []
      if (blockers.some(blocker => {
        const dependency = state.tasks[String(blocker)]
        return dependency?.status !== 'completed' || !['none', 'applied'].includes(dependency.patchStatus ?? 'none')
      })) return NO_CHANGE
      task.status = 'in_progress'; task.owner = owner; task.updatedAt = now(); task.revision++
      return structuredClone(task)
    })
  }

  async claimNextTask(owner) {
    return this.mutate(state => {
      if (Object.values(state.tasks).some(task => task.owner === owner && task.status === 'in_progress')) return NO_CHANGE
      const ids = Object.keys(state.tasks).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      for (const numericId of ids) {
        const task = state.tasks[String(numericId)]
        if (task.status !== 'pending' || (task.owner && task.owner !== owner)) continue
        if ((task.blockedBy ?? []).some(blocker => {
          const dependency = state.tasks[String(blocker)]
          return dependency?.status !== 'completed' || !['none', 'applied'].includes(dependency.patchStatus ?? 'none')
        })) continue
        task.status = 'in_progress'; task.owner = owner; task.updatedAt = now(); task.revision++
        return structuredClone(task)
      }
      return NO_CHANGE
    })
  }

  async updateTask(id, updates) {
    return this.mutate(state => {
      const task = state.tasks[String(id)]
      if (!task) throw new Error(`Unknown task: ${id}`)
      Object.assign(task, updates, { updatedAt: now(), revision: (task.revision ?? 0) + 1 })
      return structuredClone(task)
    })
  }

  async sendMessage({ from, to = 'lead', type = 'message', content = '', summary = null, requestId = null }) {
    return this.mutate(state => {
      const targets = to === '*' ? [...new Set(['lead', ...Object.keys(state.members)])].filter(name => name !== from) : [to]
      const messages = targets.map(recipient => ({ id: randomUUID(), from, to: recipient, type, content: String(content), summary, requestId, createdAt: now() }))
      state.messages.push(...messages)
      return messages.length === 1 ? messages[0] : { id: randomUUID(), from, to: '*', type, content: String(content), summary, requestId, deliveredTo: targets, createdAt: now() }
    })
  }

  async consumeMessage(recipient, predicate = () => true) {
    return this.mutate(state => {
      const index = state.messages.findIndex(message =>
        (message.to === recipient || message.to === '*' || (recipient === 'lead' && message.to === 'lead')) && predicate(message))
      if (index < 0) return NO_CHANGE
      return state.messages.splice(index, 1)[0]
    })
  }

  async pendingMessages(recipient) {
    await this.ensure()
    return this.state.messages.filter(message => message.to === recipient || message.to === '*').map(message => structuredClone(message))
  }

  async allTasksComplete() {
    await this.ensure()
    return Object.values(this.state.tasks).every(task => task.status === 'completed' && (task.patchStatus === 'none' || task.patchStatus === 'applied'))
  }
}

export { atomicWrite }
