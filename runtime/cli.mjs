#!/usr/bin/env node
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runAgent, createDemoProvider } from './agent.mjs'
import { runTui } from './tui.mjs'
import { parseRules } from './permissions.mjs'
import { parseHooksSettings } from './hooks.mjs'
import { newestSessionId, projectDir } from './session.mjs'

function usage() {
  return `MyCC - minimal Claude-Code-inspired coding agent

Usage:
  mycc --prompt "Fix the bug" [--cwd PATH]
  mycc --tui [--demo] [--cwd PATH]
  cat task.txt | mycc [--cwd PATH]

Options:
  --prompt TEXT          Task prompt
  --prompt-file PATH     Read task prompt from a file
  --cwd PATH             Workspace root (default: current directory)
  --model MODEL          Anthropic model name
  --max-turns N          Maximum model/tool iterations (non-interactive; default: unlimited)
  --json                 Print one JSON result instead of human-readable events
  --tui                  Start an interactive terminal UI
  --demo                 Run a deterministic local smoke test without an API key
  --permissions-file P   JSON settings file with {"permissions":{...}} rules
  --permission-mode M    default|acceptEdits|bypassPermissions|dontAsk|plan
  --context-window N     Model context window in tokens (default: resolved from model)
  --budget-tokens N      Continue working until this output-token budget is reached
  --session-dir PATH     Persist transcripts under PATH (default ~/.mycc/projects/<cwd>)
  --resume               Resume the latest persisted session for this workspace
  --session-id ID        Target session id (with --resume, or to name a new session)
  --help                 Show this help
`
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'plan']

function parseArgs(argv) {
  const options = { cwd: process.cwd(), json: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg === '--tui') options.tui = true
    else if (arg === '--demo') options.demo = true
    else if (arg === '--prompt') options.prompt = argv[++index]
    else if (arg === '--prompt-file') options.promptFile = argv[++index]
    else if (arg === '--cwd') options.cwd = argv[++index]
    else if (arg === '--model') options.model = argv[++index]
    else if (arg === '--max-turns') options.maxTurns = Number(argv[++index])
    else if (arg === '--permissions-file') options.permissionsFile = argv[++index]
    else if (arg === '--permission-mode') options.permissionMode = argv[++index]
    else if (arg === '--context-window') options.contextWindow = Number(argv[++index])
    else if (arg === '--budget-tokens') options.budgetTokens = Number(argv[++index])
    else if (arg === '--session-dir') options.sessionDir = argv[++index]
    else if (arg === '--resume') options.resume = true
    else if (arg === '--session-id') options.sessionId = argv[++index]
    else if (!arg.startsWith('-') && !options.prompt) options.prompt = arg
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

async function getPrompt(options) {
  if (options.promptFile) return fs.readFile(path.resolve(options.promptFile), 'utf8')
  if (options.prompt) return options.prompt
  if (!process.stdin.isTTY) return fs.readFile(0, 'utf8')
  throw new Error('Provide --prompt, --prompt-file, or pipe a prompt on stdin.')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(usage())
  process.exit(0)
}
if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error('--max-turns must be a positive integer')
if (options.permissionMode && !PERMISSION_MODES.includes(options.permissionMode)) throw new Error('--permission-mode must be one of: ' + PERMISSION_MODES.join(', '))
if (options.contextWindow !== undefined && (!Number.isInteger(options.contextWindow) || options.contextWindow < 1)) throw new Error('--context-window must be a positive integer')
if (options.budgetTokens !== undefined && (!Number.isInteger(options.budgetTokens) || options.budgetTokens < 1)) throw new Error('--budget-tokens must be a positive integer')
let permissions = []
let hooks = {}
if (options.permissionsFile) {
  const raw = await fs.readFile(path.resolve(options.permissionsFile), 'utf8')
  const settingsJson = JSON.parse(raw)
  permissions = parseRules(settingsJson, path.resolve(options.permissionsFile))
  hooks = parseHooksSettings(settingsJson)
}
const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : (options.resume || options.sessionId ? projectDir(options.cwd) : null)
let resumeSessionId = null
if (options.resume) {
  resumeSessionId = options.sessionId ?? (await newestSessionId(sessionDir))
  if (!resumeSessionId) throw new Error(`No persisted session found in ${sessionDir}`)
}

if (options.tui) {
  if (options.json) throw new Error('--json cannot be used with --tui')
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('--tui requires an interactive terminal')
  const initialPrompt = options.promptFile ? await fs.readFile(path.resolve(options.promptFile), 'utf8') : options.prompt
  await runTui({
    workspace: path.resolve(options.cwd),
    maxTurns: options.maxTurns,
    model: options.model,
    demo: options.demo,
    permissions,
    permissionMode: options.permissionMode ?? 'default',
    contextWindow: options.contextWindow,
    budgetTokens: options.budgetTokens,
    sessionDir,
    resumeSessionId,
    sessionId: options.sessionId,
    hooks,
    initialPrompt,
  })
  process.exit(0)
}

const prompt = await getPrompt(options)
const workspace = path.resolve(options.cwd)
const onEvent = options.json ? () => {} : event => {
  if (event.type === 'model_request') console.error(`[turn ${event.turn}] model request`)
  if (event.type === 'tool_call') console.error(`[turn ${event.turn}] tool: ${event.name}`)
  if (event.type === 'tool_result' && event.name === 'Bash' && event.result?.exit_code !== undefined) console.error(`[turn ${event.turn}] bash: exit ${event.result.exit_code}`)
  if (event.type === 'assistant_text') console.log(event.text)
}
const result = await runAgent({
  prompt,
  workspace,
  maxTurns: options.maxTurns,
  model: options.model,
  provider: options.demo ? createDemoProvider() : undefined,
  permissions,
  permissionMode: options.permissionMode ?? 'default',
  contextWindow: options.contextWindow,
  budgetTokens: options.budgetTokens,
  sessionDir,
  resumeSessionId,
  sessionId: options.sessionId,
  hooks,
  onEvent,
})
if (options.json) console.log(JSON.stringify({ ...result, messages: undefined }))
