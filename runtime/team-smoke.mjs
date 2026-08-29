import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { TeamSession } from './team-session.mjs'
import { runAgent } from './agent.mjs'
import { TuiSession } from './tui.mjs'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', args, { cwd })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mycc-team-smoke-'))
const agentWorkspace = await mkdtemp(path.join(os.tmpdir(), 'mycc-team-agent-'))
try {
  await git(workspace, 'init', '-q')
  await git(workspace, 'config', 'user.email', 'smoke@mycc.local')
  await git(workspace, 'config', 'user.name', 'mycc smoke')
  await writeFile(path.join(workspace, '.gitignore'), '.mycc/\n')
  await writeFile(path.join(workspace, 'tracked.txt'), 'base\n')
  await git(workspace, 'add', '.gitignore', 'tracked.txt')
  await git(workspace, 'commit', '-qm', 'base')
  await writeFile(path.join(workspace, 'tracked.txt'), 'dirty tracked\n')
  await writeFile(path.join(workspace, 'initial.txt'), 'dirty untracked\n')
  const before = (await git(workspace, 'status', '--porcelain')).stdout
  const provider = async () => ({ content: [{ type: 'text', text: 'idle' }], stop_reason: 'end_turn' })
  const session = new TeamSession({ workspace, provider, maxTeammates: 2, teammateMaxTurns: 1 })
  await session.createTeam({ team_name: 'smoke-team' })
  await session.spawnTeammate({ team_name: 'smoke-team', name: 'alice', prompt: 'wait' })
  const alice = session.store.state.members.alice
  assert.match(alice.workspace, /\.mycc\/teams\/smoke-team\/worktrees\/alice$/)
  assert.equal(await readFile(path.join(alice.workspace, 'tracked.txt'), 'utf8'), 'dirty tracked\n')
  assert.equal(await readFile(path.join(alice.workspace, 'initial.txt'), 'utf8'), 'dirty untracked\n')
  assert.equal((await git(workspace, 'status', '--porcelain')).stdout, before, 'lead dirty state is untouched')
  await stat(path.join(workspace, '.mycc', 'teams', 'smoke-team', 'config.json'))
  await stat(path.join(workspace, '.mycc', 'teams', 'smoke-team', 'inboxes', 'alice.json'))

  // The built-in Agent remains authoritative even when an extra tool tries to
  // use the same name, while the team background arguments are preserved.
  let backgroundOptions
  let leadCalls = 0
  const passthrough = await runAgent({
    prompt: 'spawn', workspace: agentWorkspace, maxTurns: 2,
    extraTools: [{ name: 'Agent', description: 'must not override', input_schema: {}, handler: () => { throw new Error('overridden') } }],
    agentTeamRunner: options => { backgroundOptions = options; return { name: options.name } },
    provider: async () => ++leadCalls === 1
      ? { content: [{ type: 'tool_use', id: 'agent', name: 'Agent', input: { team_name: 'smoke-team', name: 'alice', prompt: 'background', run_in_background: true } }] }
      : { content: [{ type: 'text', text: 'lead done' }] },
  })
  assert.equal(backgroundOptions.name, 'alice')
  assert.equal(backgroundOptions.team_name, 'smoke-team')
  assert.match(passthrough.finalText, /lead done/)

  let providerCount = 0
  const tuiRequests = []
  const tui = new TuiSession({
    workspace: agentWorkspace, team: true, maxTurns: 1,
    output: { isTTY: false, write() {} },
    providerFactory: () => {
      providerCount++
      return async request => { tuiRequests.push(request.messages); return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }
    },
  })
  await tui.submit('first')
  await tui.submit('second')
  assert.equal(providerCount, 1, 'team TUI reuses one provider and TeamSession')
  assert.ok(tuiRequests[1].some(message => JSON.stringify(message.content).includes('first')), 'team TUI keeps lead history')

  const first = await session.createTask({ subject: 'no changes', description: 'done', owner: 'alice' })
  await session.updateTask({ id: first.id, actor: 'alice', status: 'completed' })
  const second = await session.createTask({ subject: 'blocked', description: 'wait', blockedBy: [first.id] })
  assert.equal((await session.store.claimTask(second.id, 'alice')).status, 'in_progress', 'applied/no-changes dependency is ready')
  const idleRevision = session.store.state.revision
  assert.equal(await session.store.claimNextTask('alice'), null, 'a teammate cannot claim a second task while one is in progress')
  assert.equal(session.store.state.revision, idleRevision, 'empty task polling does not rewrite team state')
  await session.updateTask({ id: second.id, actor: 'alice', status: 'completed' })

  const broken = await session.createTask({ subject: 'capture failure', description: 'invalid checkpoint', owner: 'alice' })
  await session.store.claimTask(broken.id, 'alice')
  const originalBase = alice.baseRevision
  alice.baseRevision = 'not-a-revision'
  await assert.rejects(() => session.updateTask({ id: broken.id, actor: 'alice', status: 'completed' }))
  alice.baseRevision = originalBase
  assert.equal((await session.store.getTask(broken.id)).status, 'in_progress', 'failed capture does not fake completion')
  await session.updateTask({ id: broken.id, actor: 'alice', status: 'completed' })

  const third = await session.createTask({ subject: 'binary patch', description: 'add binary', owner: 'alice' })
  await writeFile(path.join(alice.workspace, 'binary.dat'), Buffer.from([0, 255, 1, 2]))
  const completed = await session.updateTask({ id: third.id, actor: 'alice', status: 'completed' })
  assert.equal(completed.patchStatus, 'pending')
  const applied = await session.applyPatch({ id: third.id })
  assert.equal(applied.patchStatus, 'applied')
  assert.deepEqual([...await readFile(path.join(workspace, 'binary.dat'))], [0, 255, 1, 2])

  await session.spawnTeammate({ team_name: 'smoke-team', name: 'bob', prompt: 'wait' })
  await pause(250)
  assert.ok(session.store.state.members.bob.syncedPatchIds.includes(String(third.id)), 'applied patch is synchronized once')
  const broadcast = await session.sendMessage({ actor: 'lead', to: '*', content: 'hello team' })
  assert.ok(!broadcast.deliveredTo.includes('lead'), 'broadcast excludes the sender')
  await session.sendMessage({ actor: 'lead', to: 'alice', type: 'shutdown_request', content: 'stop' })
  await pause(250)
  assert.ok(session.store.state.messages.some(message => message.type === 'shutdown_response' && message.from === 'alice'), 'shutdown response arrives through mailbox')

  await pause(30)
  await session.deleteTeam()
  assert.equal(session.store.state.stopped, true)
  const finalStatus = (await git(workspace, 'status', '--porcelain')).stdout.trim().split('\n').sort().join('\n')
  assert.deepEqual(finalStatus.split('\n'), [...before.trim().split('\n'), '?? binary.dat'].sort(), 'lead status remains recoverable after apply')
  console.log('team smoke: PASS')
} finally {
  await rm(workspace, { recursive: true, force: true })
  await rm(agentWorkspace, { recursive: true, force: true })
}
