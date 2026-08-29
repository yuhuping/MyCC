// multiagent/lib/agent-instance.mjs
// 把 MyCC runAgent 包装成"多智能体编排里的一个 agent 实例"：
//   - 注入角色 profile（来自 MultiAgentBench 任务的 agents 配置）
//   - 工作区由编排层注入：main / read_only（同一 main）/ isolated worktree
//   - 携带 roleContract（Audit §6「Prompt 随权限切换」）——agent 只接收
//     roleContract/workspace/sessionDir/context，不持有拓扑/merge 逻辑
//   - 结构化交付物：对 review/test_review/integrate/verify/patch 类 node，
//     要求 finalText 末尾输出 JSON 块，由编排层提取、校验、落盘
import path from 'node:path'
import { runAgent } from '../../runtime/agent.mjs'
import { createProvider } from './providers.mjs'

// 权限策略 -> prompt 注入约束（Audit §6 表）
const POLICY_PROMPTS = {
  lead:
    'You are the LEAD agent and the ONLY node that writes the scaffold in the main workspace. ' +
    'Decompose the team objective into independent file-level work items, create the skeleton ' +
    '(solution.py entry + modules/__init__.py + test_solution.py) with EXACT function signatures ' +
    'and the shared data contract, and assign each worker node its OWN file. ' +
    'Do NOT implement the worker slices yourself — leave that to the workers. ' +
    'Use postTeamMessage to announce the contract to the team, and getTeamMessages to read teammates\' questions.',
  main_writer:
    'You are the CURRENT SOLE WRITER of the main workspace. Report what you changed and how you verified it. ' +
    'Do NOT delete or clean up files/artifacts produced by other nodes — only touch what your own task requires.',
  read_only:
    'You have READ-ONLY access to the workspace: you must NOT use Write/Edit/Bash that modifies tracked files, ' +
    'and you must NOT delete anything. Investigate with Read/Glob/Grep and read-only Bash, then deliver a ' +
    'structured review with file paths and line numbers as evidence.',
  isolated_patch:
    'You operate in an ISOLATED worktree checked out from a fixed base revision. Only modify files inside your own ' +
    'worktree; NEVER assume other workers\' changes exist, and NEVER try to merge the main branch or read other ' +
    'workers\' uncommitted files. Deliver an applicable patch (diff vs base) plus the tests that prove it.\n' +
    'TEAM COMMUNICATION IS MANDATORY for you: (1) call getTeamMessages at least once BEFORE finalizing, so you can see ' +
    'what the other worker announced; (2) postTeamMessage a short note announcing the exact signatures you implemented ' +
    'and any convention you followed; (3) if a teammate\'s announcement conflicts with your module, post an explicit ' +
    'warning and align with the lead\'s contract.',
  integrator:
    'You are the INTEGRATOR and the ONLY node allowed to bring changes back into the main workspace. Consume ONLY ' +
    'the dependency artifacts listed in your context; decide adopt/reject for each item explicitly. Conflicts and ' +
    'stale patches must be reported explicitly — never silently pick "the last worker to finish". Perform the ' +
    'minimal necessary integration changes, then report verification results.',
  verifier:
    'You are the VERIFIER. By default do NOT fix code — run the allowed verification commands and report evidence ' +
    '(commands, exit codes, outputs). If verification fails, output a minimal reproduction for later patch nodes ' +
    'to consume. Your verdict is evidence, not a patch.\n' +
    'TEAM COMMUNICATION AUDIT: call getTeamMessages and list in verification.json.evidence what the LEAD and each WORKER ' +
    'posted on the team channel (quote them); if any worker posted nothing, add "missing_worker_communication" to defects[].',
}

/** 由 node 的 kind + workspaceMode 推导权限策略（测试与编排层共用）。 */
export function deriveRoleContract({ kind, workspaceMode }) {
  if (kind === 'lead') return { policy: 'lead', artifactFile: 'lead.json' }
  if (kind === 'integrate') return { policy: 'integrator', artifactFile: 'integration.json' }
  if (kind === 'verify') return { policy: 'verifier', artifactFile: 'verification.json' }
  if (kind === 'review') return { policy: 'read_only', artifactFile: 'review.json' }
  if (kind === 'test_review') return { policy: 'read_only', artifactFile: 'test-plan.json' }
  if (kind === 'patch') return { policy: 'isolated_patch', artifactFile: 'patch.json' }
  // implement
  if (workspaceMode === 'main') return { policy: 'main_writer', artifactFile: null }
  return { policy: 'isolated_patch', artifactFile: null }
}

function buildPrompt({ profile, task, context, roleContract, artifactNudge }) {
  const parts = []
  if (profile) parts.push(`# Your role in the team\n${profile}\n`)
  if (context) parts.push(`# What your teammates have produced (verified artifacts only)\n${context}\n`)
  if (artifactNudge) parts.push(`# Correction from the coordinator\n${artifactNudge}\n`)
  parts.push(
    '# Your task\n' +
    `Work on your assigned slice of the team objective below. Workspace: ${path.basename(roleContract.workspace ?? '.')}\n\n` +
    `Team objective:\n${task}\n`
  )
  if (roleContract.policy) {
    parts.push('# Workspace policy\n' + POLICY_PROMPTS[roleContract.policy])
  }
  if (roleContract.artifactFile) {
    parts.push(
      '# Required deliverable\n' +
      'Finish your final message with a SINGLE JSON code block (a fenced block of JSON, i.e. a triple-backtick "json" fence) named after your node ' +
      `(${roleContract.nodeId ?? '?'}). It must include at minimum: "node_id": "${roleContract.nodeId ?? ''}", ` +
      `"agent_id": "${roleContract.agentId ?? ''}"${roleContract.artifactFile === 'patch.json' ? ', "base_revision": <the base SHA from your context>' : ''}, ` +
      `plus the structured fields your node kind requires (${describeArtifact(roleContract.artifactFile)}). ` +
      'Do not put this JSON anywhere else in the transcript.'
    )
  }
  return parts.join('\n')
}

function describeArtifact(file) {
  switch (file) {
    case 'lead.json':
      return 'modules: [file paths you assigned], ownership: {module_file: worker_agent_id}, acceptance: [acceptance criteria / test commands], summary: string'
    case 'review.json':
      return 'verdict ("approve"|"changes_requested"), issues: [{severity: critical|major|minor|info, path, line, message, suggestion?}]'
    case 'test-plan.json':
      return 'coverage: [{area, tests}], commands: [shell commands to verify], expectations: string'
    case 'patch.json':
      return 'files: [changed paths relative to base], test_commands: [commands that prove the patch], summary: string'
    case 'integration.json':
      return 'decisions: [{source, artifact, adopted, reason}], conflicts: [{source, file, reason}], stale_patches: [{source, reason}], test_commands: [commands], summary: string'
    case 'verification.json':
      return 'commands: [commands you ran], evidence: string, defects: [string]'
    default:
      return 'the fields described by your node kind'
  }
}

export class AgentInstance {
  constructor({ agentId, type, profile, workspace, model, maxTurns, sessionDir, provider, team = null }) {
    this.agentId = agentId
    this.type = type ?? 'BaseAgent'
    this.profile = profile ?? ''
    this.workspace = workspace
    this.model = model
    this.maxTurns = maxTurns
    this.sessionDir = sessionDir
    this.provider = provider
    this.team = team // 团队通信信道 { post(from,to,message), feed(agentId), messages }
  }

  /** Worker↔Worker / Lead↔Worker 实时通信工具（编排层注入，跨 node 共享信道）。 */
  buildTeamTools() {
    const team = this.team
    if (!team) return []
    return [
      {
        name: 'postTeamMessage',
        description: 'Post a short message to the team channel. Other agents (Lead, worker A/B, integrator, verifier) can read it via getTeamMessages. Use it to announce your implemented function signatures, shared constants, or ask/answer questions — coordination matters because you work in parallel.',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'The message content, concise.' },
            to: { type: 'string', description: 'Optional: target agent id (e.g. "workerA", "lead"). Omit to broadcast to the whole team.' },
          },
          required: ['message'],
          additionalProperties: false,
        },
        handler: (input) => {
          const m = team.post(this.agentId, input.to ?? null, input.message)
          return { status: true, message: `posted team message #${m.seq}` }
        },
      },
      {
        name: 'getTeamMessages',
        description: 'Read the latest messages posted by your teammates on the team channel (excluding your own). Call this before finalizing to check for contract updates, questions directed at you, or warnings from other workers.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        handler: () => ({ status: true, message: team.feed(this.agentId) }),
      },
    ]
  }

  async run({ task, context, sessionDir, signal, nodeMeta, artifactNudge } = {}) {
    const roleContract = nodeMeta
      ? { ...deriveRoleContract(nodeMeta), workspace: nodeMeta.workspace ?? this.workspace, nodeId: nodeMeta.nodeId, agentId: this.agentId }
      : { workspace: this.workspace, nodeId: null, agentId: this.agentId }
    const prompt = buildPrompt({ profile: this.profile, task, context, roleContract, artifactNudge })
    const provider = this.provider ?? createProvider({ model: this.model })
    const result = await runAgent({
      prompt,
      workspace: this.workspace,
      provider,
      maxTurns: this.maxTurns,
      extraTools: this.buildTeamTools(),
      onEvent: nodeMeta?.onEvent ?? (() => {}),
      sessionDir: sessionDir ?? this.sessionDir,
      signal,
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
      roleContract,
    }
  }

  // 传给下一棒的上下文：本 agent 的结论 + 状态摘要（截断以控成本；仅 relay 使用）
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