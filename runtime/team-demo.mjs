#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TeamSession } from './team-session.mjs'

const exec = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function blocks(...items) {
  return {
    role: 'assistant',
    content: items.flat().filter(Boolean),
    stop_reason: items.flat().some(item => item?.type === 'tool_use') ? 'tool_use' : 'end_turn',
  }
}

const text = value => ({ type: 'text', text: value })
const tool = (id, name, input = {}) => ({ type: 'tool_use', id, name, input })

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'tool_result') return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
    return ''
  }).join('\n')
}

function messageText(messages) {
  return messages.map(message => contentText(message.content)).join('\n')
}

function previousToolUses(messages) {
  const previous = [...messages].reverse().find(message => message.role === 'assistant' && Array.isArray(message.content))
  return previous?.content?.filter(block => block.type === 'tool_use') ?? []
}

function hasUsedTool(messages, name) {
  return messages.some(message => Array.isArray(message.content) && message.content.some(block => block?.type === 'tool_use' && block.name === name))
}

function latestPrompt(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const content = messages[index].content
    if (messages[index].role !== 'user') continue
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const prompt = content.filter(block => block?.type !== 'tool_result').map(block => block?.type === 'text' ? block.text : '').filter(Boolean).join('\n')
      if (prompt) return prompt
    }
  }
  return ''
}

/** A zero-API provider that drives the real AgentTeam tools deterministically. */
export function createTeamDemoProvider({ delayMs = 0 } = {}) {
  const applied = new Set()
  return async request => {
    if (delayMs) await pause(delayMs)
    const tools = new Set((request.tools ?? []).map(definition => definition.name))
    const messages = request.messages ?? []
    const history = messageText(messages)
    const prompt = latestPrompt(messages)
    const previous = previousToolUses(messages)
    const isLead = tools.has('TeamCreate')

    if (isLead) {
      if (!hasUsedTool(messages, 'TeamCreate')) {
        return blocks(
          text('I’ll split this into two isolated tracks and integrate only verified patches.'),
          tool('lead-team', 'TeamCreate', { team_name: 'demo-team', description: 'Ship and verify an AgentTeam capability card' }),
          tool('lead-architect', 'Agent', { team_name: 'demo-team', name: 'architect', prompt: 'ROLE=architect. Wait for the implementation task.', run_in_background: true }),
          tool('lead-verifier', 'Agent', { team_name: 'demo-team', name: 'verifier', prompt: 'ROLE=verifier. Wait for the contract-test task.', run_in_background: true }),
          tool('lead-task-1', 'TaskCreate', { subject: 'Implement capability module', description: 'Add src/capabilities.mjs with the AgentTeam capability contract.', owner: 'architect' }),
          tool('lead-task-2', 'TaskCreate', { subject: 'Add contract test', description: 'Add test/capabilities.test.mjs that verifies the capability contract.', owner: 'verifier' }),
        )
      }

      const appliedTool = previous.find(item => item.name === 'TeamApplyPatch')
      if (appliedTool) {
        applied.add(String(appliedTool.input.task_id))
        if (applied.size === 2) {
          return blocks(
            text('Both patches are integrated. Running the repository gate now.'),
            tool('lead-test', 'Bash', { command: 'node --test --test-reporter=spec' }),
            tool('lead-list-final', 'TaskList'),
          )
        }
        return blocks(
          text('First delivery integrated; the other teammate remains independent and in flight.'),
          tool('lead-list-progress', 'TaskList'),
        )
      }

      if (previous.some(item => item.name === 'Bash')) {
        return blocks(
          text('The integrated result passed. Closing the team cleanly.'),
          tool('lead-delete', 'TeamDelete'),
        )
      }

      if (previous.some(item => item.name === 'TeamDelete')) {
        return blocks(text('AgentTeam demo complete: 2 parallel worktrees, 2 reviewed patches, 1 green integration gate.'))
      }

      if (previous.some(item => item.name === 'TaskList')) {
        return blocks(text('Team status recorded; continuing while the remaining track finishes.'))
      }

      const completed = prompt.match(/Task (\d+) completed; patch pending application/)
      if (completed) {
        return blocks(
          text(`Delivery received for task #${completed[1]}; checking and applying its patch.`),
          tool(`lead-apply-${completed[1]}`, 'TeamApplyPatch', { task_id: completed[1] }),
        )
      }

      if (previous.some(item => item.name === 'TeamCreate')) {
        return blocks(text('Team launched: architect and verifier are working in parallel worktrees.'))
      }

      return blocks(text('Inbox acknowledged; waiting for a patch-backed delivery.'))
    }

    const role = history.includes('ROLE=architect') ? 'architect' : 'verifier'
    const task = prompt.match(/\[Team task (\d+)\] ([^\n]+)/)

    if (task && previous.length === 0) {
      if (task[2] === 'Implement capability module') {
        return blocks(
          text('Implementing the capability contract in my isolated worktree.'),
          tool('architect-write', 'Write', {
            file_path: 'src/capabilities.mjs',
            content: "export const capabilities = {\n  orchestration: 'AgentTeam',\n  isolation: 'git-worktree',\n  verification: 'required',\n}\n",
          }),
          tool('architect-progress', 'SendMessage', { to: 'lead', message: 'Capability module implemented; capturing a patch-backed delivery.' }),
        )
      }
      return blocks(
        text('Writing a black-box contract test in my isolated worktree.'),
        tool('verifier-write', 'Write', {
          file_path: 'test/capabilities.test.mjs',
          content: "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { capabilities } from '../src/capabilities.mjs'\n\ntest('publishes the AgentTeam contract', () => {\n  assert.deepEqual(capabilities, {\n    orchestration: 'AgentTeam',\n    isolation: 'git-worktree',\n    verification: 'required',\n  })\n})\n",
        }),
        tool('verifier-progress', 'SendMessage', { to: 'lead', message: 'Contract test ready; capturing a patch-backed delivery.' }),
      )
    }

    if (previous.some(item => item.name === 'Write')) {
      const taskId = role === 'architect' ? '1' : '2'
      return blocks(
        tool(`${role}-complete`, 'TaskUpdate', { task_id: taskId, status: 'completed' }),
        tool(`${role}-summary`, 'SendMessage', { to: 'lead', message: `${role} delivery complete: task #${taskId} has a reviewable patch.` }),
      )
    }

    if (previous.some(item => item.name === 'TaskUpdate')) {
      return blocks(text(`${role} is idle after delivering its patch.`))
    }

    if (prompt.includes('is assigned to you')) {
      return blocks(text(`${role} acknowledged the assignment and is starting now.`))
    }

    if (!history.includes('ready for an assigned track')) {
      return blocks(
        tool(`${role}-ready`, 'SendMessage', { to: 'lead', message: `${role} ready for an assigned track.` }),
      )
    }

    return blocks(text(`${role} is ready.`))
  }
}

function palette(output) {
  const enabled = Boolean(output?.isTTY) && !process.env.NO_COLOR
  const color = code => value => enabled ? `\u001b[${code}m${value}\u001b[0m` : value
  return { dim: color('2'), cyan: color('36'), blue: color('94'), green: color('92'), yellow: color('93'), magenta: color('95'), bold: color('1') }
}

export function createTeamDemoRenderer(output = process.stdout) {
  const c = palette(output)
  const line = value => output?.write(`${value}\n`)
  const taskNames = new Map()
  return event => {
    const actor = event.teammate ?? event.name ?? 'lead'
    const who = actor === 'lead' ? c.blue('◆ lead') : c.magenta(`◇ ${actor}`)
    if (event.type === 'team_created') line(`${c.green('✓')} team created      ${c.dim('demo-team')}`)
    if (event.type === 'teammate_spawned') line(`${c.green('├─')} teammate online   ${c.magenta(event.name)} ${c.dim('[isolated worktree]')}`)
    if (event.type === 'teammate_turn_start' && event.kind === 'task') {
      taskNames.set(event.task.id, event.task.subject)
      line(`${c.yellow('↳')} ${who} claimed #${event.task.id}  ${event.task.subject}`)
    }
    if (event.type === 'tool_call' && event.name === 'TaskCreate') line(`${c.cyan('+')} ${who} planned task   ${event.input.subject}`)
    if (event.type === 'tool_call' && event.name === 'Write') line(`${c.cyan('↳')} ${who} editing        ${event.input.file_path}`)
    if (event.type === 'tool_result' && event.name === 'TaskUpdate' && event.result?.status === 'completed') {
      line(`${c.green('✓')} ${who} delivered #${event.result.id} ${c.dim(`[patch ${event.result.patch?.bytes ?? 0} B]`)}`)
    }
    if (event.type === 'team_message' && event.message?.type === 'message') line(`${c.yellow('→')} ${event.message.from} → ${event.message.to}  ${event.message.content}`)
    if (event.type === 'tool_call' && event.name === 'TeamApplyPatch') line(`${c.cyan('↳')} ${who} review + apply  task #${event.input.task_id}`)
    if (event.type === 'tool_result' && event.name === 'TeamApplyPatch' && event.result?.patchStatus === 'applied') {
      line(`${c.green('✓')} patch applied     #${event.result.id} ${c.dim(taskNames.get(event.result.id) ?? '')}`)
    }
    if (event.type === 'tool_call' && event.name === 'Bash') line(`${c.cyan('↳')} ${who} verification    ${event.input.command}`)
    if (event.type === 'tool_result' && event.name === 'Bash') line(`${c.green('✓')} integration gate  ${event.result.exit_code === 0 ? 'PASS · 1 test · 0 failed' : 'FAIL'}`)
    if (event.type === 'team_deleted') line(`${c.green('✓')} team closed       worktrees cleaned`)
  }
}

async function createFixture() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'mycc-agentteam-demo-'))
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await mkdir(path.join(workspace, 'test'), { recursive: true })
  await writeFile(path.join(workspace, '.gitignore'), '.mycc/\n')
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'agentteam-demo', private: true, type: 'module' }, null, 2) + '\n')
  await writeFile(path.join(workspace, 'src', 'index.mjs'), "export const name = 'MyCC'\n")
  await exec('git', ['init', '-q'], { cwd: workspace })
  await exec('git', ['add', '-A'], { cwd: workspace })
  await exec('git', ['-c', 'user.email=demo@mycc.local', '-c', 'user.name=MyCC', 'commit', '-qm', 'demo fixture'], { cwd: workspace })
  return workspace
}

export async function runTeamDemo({ output = process.stdout, delayMs = 180, keepWorkspace = false, onEvent = null } = {}) {
  const workspace = await createFixture()
  const events = []
  const startedAt = Date.now()
  const c = palette(output)
  output?.write(`${c.bold('MyCC AgentTeam')} ${c.dim('· deterministic offline demo · zero API')}\n`)
  output?.write(`${c.dim('Task: ship a capability module and verify it through two parallel agents')}\n\n`)
  const render = createTeamDemoRenderer(output)
  const session = new TeamSession({
    workspace,
    provider: createTeamDemoProvider({ delayMs }),
    maxTeammates: 2,
    teammateMaxTurns: 4,
    onEvent: event => {
      const stamped = { ...event, atMs: Date.now() - startedAt }
      events.push(stamped)
      render(event)
      onEvent?.(stamped)
    },
  })
  try {
    const result = await session.run('Run the deterministic demo-team workflow.')
    const capabilitySource = await readFile(path.join(workspace, 'src', 'capabilities.mjs'), 'utf8')
    const testSource = await readFile(path.join(workspace, 'test', 'capabilities.test.mjs'), 'utf8')
    output?.write(`\n${c.green('✔ AGENTTEAM COMPLETE')} ${c.dim('2 teammates · 2 patches · integration verified')}\n`)
    return { result, workspace, capabilitySource, testSource, events }
  } finally {
    if (!keepWorkspace) await rm(workspace, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) await runTeamDemo()
