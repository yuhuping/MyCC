import readline from 'node:readline/promises'
import { createDemoProvider, runAgent } from './agent.mjs'
import { TeamSession } from './team-session.mjs'
import { listSessions, resumeMessages } from './session.mjs'

function writeLine(output, text = '') {
  output.write(`${text}\n`)
}

function summarize(value) {
  const text = JSON.stringify(value) ?? ''
  return text.length > 500 ? `${text.slice(0, 497)}...` : text
}

export class TuiSession {
  constructor({ workspace, maxTurns, model, team = false, maxTeammates = 4, demo = false, output = process.stdout, input = process.stdin, run = runAgent, providerFactory, sessionDir = null, permissions = [], permissionMode = 'default', hooks = {}, resumeSessionId = null, sessionId = null, contextWindow = undefined, budgetTokens = null } = {}) {
    this.options = { workspace, maxTurns, model }
    // 透传给 runAgent 的策略参数(权限/hook/持久化等),submit 时一并转发
    this.passThrough = { permissions, permissionMode, hooks, sessionDir, resumeSessionId, sessionId, contextWindow, budgetTokens }
    this.demo = demo
    this.output = output
    this.input = input
    this.sessionDir = sessionDir
    this.run = run
    this.providerFactory = providerFactory || (demo ? () => createDemoProvider() : () => undefined)
    this.team = team
    this.maxTeammates = maxTeammates
    this.teamSession = null
    this.messages = []
  }

  showHelp() {
    writeLine(this.output, 'Commands: /help  Show this help | /clear  Clear the screen and conversation | /sessions  Browse and resume persisted sessions | /exit  Quit')
  }

  clear() {
    if (this.output.isTTY) this.output.write('\x1Bc')
    this.messages = []
    writeLine(this.output, 'Conversation cleared.')
  }

  // 单行提问(复用临时 readline,不干扰主循环)
  async askLine(question) {
    writeLine(this.output, question)
    const terminal = readline.createInterface({ input: this.input, output: this.output })
    try {
      return await terminal.question('')
    } finally {
      terminal.close()
    }
  }

  // 交互式权限询问:ask 规则触发时向用户提问,返回是否允许
  async askPermission({ toolName, message }) {
    const answer = await this.askLine(`\n${message} (y/n) `)
    return /^y(es)?$/i.test(answer.trim())
  }

  // 历史会话浏览:列出持久化会话并选择恢复
  async browseSessions() {
    if (!this.sessionDir) {
      writeLine(this.output, 'Session persistence is not enabled. Start with --session-dir to browse sessions.')
      return { command: 'sessions', count: 0 }
    }
    const sessions = await listSessions(this.sessionDir)
    if (!sessions.length) {
      writeLine(this.output, 'No persisted sessions found.')
      return { command: 'sessions', count: 0 }
    }
    sessions.forEach((session, index) => {
      writeLine(this.output, `${index + 1}. ${session.sessionId}  ${new Date(session.updatedAt).toISOString()}  (${session.messageCount} messages)`)
    })
    const choice = (await this.askLine('Enter a number to resume, or empty to cancel: ')).trim()
    const index = Number(choice) - 1
    if (choice && Number.isInteger(index) && index >= 0 && index < sessions.length) {
      const target = sessions[index]
      this.messages = await resumeMessages(this.sessionDir, target.sessionId)
      writeLine(this.output, `Resumed ${target.sessionId} (${this.messages.length} messages). Type your next instruction.`)
      return { command: 'sessions', resumed: target.sessionId }
    }
    return { command: 'sessions', resumed: null }
  }

  async submit(input) {
    const prompt = input.trim()
    if (!prompt) return { empty: true }
    if (prompt === '/help') {
      this.showHelp()
      return { command: 'help' }
    }
    if (prompt === '/clear') {
      this.clear()
      return { command: 'clear' }
    }
    if (prompt === '/exit') return { exit: true }
    if (prompt === '/sessions') return await this.browseSessions()
    if (prompt.startsWith('/')) {
      writeLine(this.output, `Unknown command: ${prompt}. Use /help.`)
      return { command: 'unknown' }
    }

    let streamedDelta = false
    const renderAgentEvent = event => {
      if (event.type === 'model_request') writeLine(this.output, `[turn ${event.turn}] model request`)
      if (event.type === 'tool_call') writeLine(this.output, `[turn ${event.turn}] tool: ${event.name}`)
      if (event.type === 'tool_result') writeLine(this.output, `[turn ${event.turn}] result: ${event.name} ${summarize(event.result)}`)
      if (event.type === 'assistant_text_delta') {
        streamedDelta = true
        this.output.write(event.text)
      }
      if (event.type === 'assistant_text' && !streamedDelta) writeLine(this.output, `\n${event.text}\n`)
      if (event.type === 'max_turns') writeLine(this.output, `Stopped after ${event.turns} turns.`)
    }
    const runOptions = {
      ...this.options,
      ...this.passThrough,
      prompt,
      messages: this.messages,
      onPermissionRequest: this.askPermission.bind(this),
      onEvent: renderAgentEvent,
    }
    let result
    if (this.team) {
      if (!this.teamSession || this.teamSession.store.state?.stopped) {
        this.teamSession = new TeamSession({
          ...this.options,
          ...this.passThrough,
          maxTeammates: this.maxTeammates,
          provider: this.providerFactory(),
          onPermissionRequest: this.askPermission.bind(this),
          onEvent: event => {
            if (event.type === 'team_message' || event.type === 'team_created' || event.type === 'teammate_idle' || event.type === 'teammate_stopped') writeLine(this.output, `[team] ${event.type}`)
            if (event.teammate === 'lead') renderAgentEvent(event)
          },
        })
        this.teamSession.leadHistory = this.messages
      }
      result = await this.teamSession.run(prompt)
    } else {
      result = await this.run({ ...runOptions, provider: this.providerFactory() })
    }
    this.messages = result.messages
    return { result }
  }
}

export async function runTui({ input = process.stdin, output = process.stdout, initialPrompt, ...options } = {}) {
  const session = new TuiSession({ ...options, input, output })
  writeLine(output, 'MyCC TUI. Type /help for commands.')
  if (initialPrompt) await session.submit(initialPrompt)

  const terminal = readline.createInterface({ input, output, terminal: input.isTTY && output.isTTY })
  try {
    while (true) {
      let line
      try {
        line = await terminal.question('mycc> ')
      } catch {
        break
      }
      try {
        if ((await session.submit(line)).exit) break
      } catch (error) {
        writeLine(output, `Error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    terminal.close()
  }
}
