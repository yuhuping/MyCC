// multiagent/lib/agent-instance.mjs
// 把 MyCC runAgent 包装成"多智能体编排里的一个 agent 实例"：
//   - 注入角色 profile（来自 MultiAgentBench 任务的 agents 配置）
//   - 与其它 agent 共享同一工作区（共享文件系统 = 共享状态）
//   - 可携带前驱 agent 的下文（接力 context）
//   - 产出 finalText / transcript / diff / messages（供编排层汇总与下一棒接力）
import path from 'node:path'
import { runAgent } from '../../runtime/agent.mjs'
import { createProvider } from './providers.mjs'

function buildPrompt({ profile, task, context }) {
  const parts = []
  if (profile) {
    parts.push(`# Your role in the team\n${profile}\n`)
  }
  if (context) {
    parts.push(`# What your teammates have done so far\n${context}\n`)
  }
  parts.push(
    '# Your task\n' +
    `Complete the team's overall objective below. Work directly in the shared workspace with your tools` +
    ` (Read/Write/Edit/Glob/Grep/Bash). The team's final deliverable must be written as files in this workspace.\n\n` +
    `${task}\n`
  )
  parts.push(
    '# Team protocol\n' +
    '- You are ONE member of a multi-agent team; each member works sequentially in the same workspace.\n' +
    '- Before writing new code, Read the existing files in the workspace to avoid clobbering teammates work.\n' +
    '- If the overall objective is already mostly solved, focus on your role: review, fix, or optimize what is there.\n' +
    '- Finish by writing the final deliverable (e.g. solution.py) into the workspace and state what you changed.\n'
  )
  return parts.join('\n')
}

export class AgentInstance {
  constructor({ agentId, type, profile, workspace, model, maxTurns, sessionDir, provider }) {
    this.agentId = agentId
    this.type = type ?? 'BaseAgent'
    this.profile = profile ?? ''
    this.workspace = workspace
    this.model = model
    this.maxTurns = maxTurns
    this.sessionDir = sessionDir
    this.provider = provider
  }

  async run({ task, context, onEvent = () => {} }) {
    const prompt = buildPrompt({ profile: this.profile, task, context })
    const provider = this.provider ?? createProvider({ model: this.model })
    const result = await runAgent({
      prompt,
      workspace: this.workspace,
      provider,
      maxTurns: this.maxTurns,
      onEvent,
      sessionDir: this.sessionDir,
    })
    return {
      agentId: this.agentId,
      profile: this.profile,
      finalText: result.finalText,
      turns: result.turns,
      diff: result.diff,
      transcript: result.transcript,
      termination: result.termination,
      model: result.model,
    }
  }

  // 传给下一棒的上下文：本 agent 的结论 + 状态摘要（截断以控成本）
  summarize(run, { maxContextChars = 6000 } = {}) {
    const text = (run.finalText || '').trim()
    const diffHead = (run.diff || '').slice(0, 800)
    const parts = []
    parts.push(`[agent=${this.agentId}] (${this.profile.split('\n')[0].slice(0, 80)})`)
    parts.push(`turns=${run.turns} termination=${run.termination}`)
    if (text) {
      parts.push(`final message:\n${text.length > maxContextChars ? text.slice(0, maxContextChars) + '\n...[truncated]' : text}`)
    }
    if (diffHead) {
      parts.push(`workspace diff head (${'cd ' + path.basename(this.workspace)}):\n${diffHead}`)
    }
    return parts.join('\n')
  }
}