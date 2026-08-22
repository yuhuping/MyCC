import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { executeTool, collectGitDiff, createPostCompactFileAttachments, formatToolResultForModel, TOOL_DEFINITIONS } from './tools.mjs'
import { createStreamingProvider, StreamPartialError } from './stream.mjs'
import { buildSystemPrompt } from './prompt.mjs'
import { shouldCompact, compactMessages, splitMessagesForCompact, estimateTokens, createBudgetTracker, checkTokenBudget, mergeConsecutiveUserMessages, microCompact, getMaxOutputTokensForModel, getContextWindowForModel } from './compact.mjs'
import { resumeMessages, createSessionRecorder } from './session.mjs'
import { executeHooks, isBlocked, collectAdditionalContext } from './hooks.mjs'
import './env.mjs'

// 默认模型对齐当前源码快照的参考模型(src/constants/prompts.ts CLAUDE_4_5_OR_4_6_MODEL_IDS.sonnet)
const DEFAULT_MODEL = process.env.MYCC_MODEL || 'claude-sonnet-4-6'
// 工具结果预算:对齐 src/constants/toolLimits.ts(单结果 50k / 聚合 200k / preview 2KB;
// Read 工具豁免,对应 FileReadTool maxResultSizeChars: Infinity)
const TOOL_RESULT_BUDGET_CHARS = 50_000
const TOOL_RESULT_BUDGET_BY_TOOL = new Map([['Grep', 20_000], ['Bash', 30_000]])
const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000
const PREVIEW_SIZE_BYTES = 2_000
const READ_TOOL_NAMES = new Set(['Read'])
const TOOL_RESULTS_DIR = path.join(os.tmpdir(), 'mycc-tool-results')
const MAX_COMPACT_FAILURES = 3
// max_tokens 截断恢复:1 次 escalate 到 64k + 最多 3 次注入 continue 消息(源码 query.ts:164,1185-1255)
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
const MAX_OUTPUT_TOKENS_ESCALATION_CAP = 64_000
export const MAX_AGENT_DEPTH = 3

export class AgentRunError extends Error {
  constructor(cause, partialResult) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'AgentRunError'
    this.cause = cause
    this.partialResult = partialResult
  }
}

export function extractText(content = []) {
  return content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

function extractToolUses(content = []) {
  return content.filter(block => block.type === 'tool_use')
}

function asBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

function readPathsFromMessages(messages) {
  const paths = new Set()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block?.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string') {
        paths.add(block.input.file_path.replaceAll('\\', '/'))
      }
    }
  }
  return paths
}

export function createAnthropicProvider({ apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_MODEL, baseUrl = process.env.MYCC_API_BASE_URL || 'https://api.anthropic.com' } = {}) {
  return createStreamingProvider({ apiKey, model, baseUrl })
}

export function createDemoProvider() {
  let step = 0
  return async () => {
    step++
    if (step === 1) {
      return {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'demo-glob', name: 'Glob', input: { pattern: '**' } }],
        stop_reason: 'tool_use',
      }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'Demo completed: the local tool loop, workspace boundary, and message turn handling are running.' }],
      stop_reason: 'end_turn',
    }
  }
}

// 工具并发分组:读工具(只读)并发执行,写工具串行(toolOrchestration.ts:91-116 简化版)
function partitionToolCalls(toolUses) {
  return toolUses.reduce((acc, toolUse, index) => {
    const definition = TOOL_DEFINITIONS.find(tool => tool.name === toolUse.name)
    const isConcurrencySafe = definition?.isReadOnly === true
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1].blocks.push({ toolUse, index })
    } else {
      acc.push({ isConcurrencySafe, blocks: [{ toolUse, index }] })
    }
    return acc
  }, [])
}

// 大工具结果落盘,回传 persisted-output 提示与绝对路径
// (applyToolResultBudget / toolResultStorage.ts:186-199 语义;Read 工具豁免)
async function serializeToolResult(result, toolName) {
  const text = formatToolResultForModel(toolName, result)
  const budget = TOOL_RESULT_BUDGET_BY_TOOL.get(toolName) ?? TOOL_RESULT_BUDGET_CHARS
  if (text.length <= budget || READ_TOOL_NAMES.has(toolName)) return text
  const file = path.join(TOOL_RESULTS_DIR, `${randomUUID()}.txt`)
  await fs.mkdir(TOOL_RESULTS_DIR, { recursive: true })
  await fs.writeFile(file, text, { mode: 0o600 })
  return `<persisted-output>\nOutput too large (${text.length} characters). Full output saved to: ${file}\n\nPreview (first 2 KB):\n${text.slice(0, PREVIEW_SIZE_BYTES)}\n...\n</persisted-output>`
}

// Anthropic Messages API 只接受 { role, content } 等标准字段;剥离内部元数据
// (usage 供 autocompact 估算、isCompactSummary 标记摘要消息、subtype 标记 boundary),
// 否则带这些键的 assistant/user 消息会 400
function stripMessageMetadata(messages) {
  return messages.map(m => {
    const copy = { ...m }
    delete copy.usage
    delete copy.isCompactSummary
    delete copy.subtype
    return copy
  })
}

// 单条 user message 聚合上限 200k(toolLimits.ts MAX_TOOL_RESULTS_PER_MESSAGE_CHARS):
// 超限时把最大的字符串结果落盘替换。readToolIds(Read 豁免,源码 skipToolNames 语义)
// 不参与压缩
async function enforceAggregateBudget(toolResults, readToolIds = new Set()) {
  for (let guard = 0; guard < toolResults.length + 1; guard++) {
    let total = 0
    let maxIdx = -1
    let maxLen = 0
    toolResults.forEach((tr, index) => {
      const len = typeof tr.content === 'string' ? tr.content.length : JSON.stringify(tr.content ?? '').length
      total += len
      if (len > maxLen && !readToolIds.has(tr.tool_use_id)) { maxLen = len; maxIdx = index }
    })
    if (total <= MAX_TOOL_RESULTS_PER_MESSAGE_CHARS) return
    const tr = toolResults[maxIdx]
    if (maxIdx === -1 || typeof tr.content !== 'string' || tr.content.startsWith('<persisted-output>')) return
    const file = path.join(TOOL_RESULTS_DIR, `${randomUUID()}.json`)
    await fs.mkdir(TOOL_RESULTS_DIR, { recursive: true })
    await fs.writeFile(file, tr.content, { mode: 0o600 })
    tr.content = `<persisted-output>\nOutput too large. Full output saved to: ${file}\n\nPreview (first 2 KB):\n${tr.content.slice(0, PREVIEW_SIZE_BYTES)}\n...\n</persisted-output>`
  }
}

// 强制收敛:连续 N 轮无 Edit/Write 时注入提醒(针对只读探索死循环不产出 patch;
// 19 个 no_patch 实例全部 50 轮零修改,8 轮阈值给足定位时间后开始干预)
const FORCE_EDIT_INTERVAL = 8
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write'])
const FORCE_EDIT_NUDGE = 'You have spent several turns investigating without making any edit to the code. Stop exploring and act now: state your hypothesis about the root cause, then make the smallest possible edit that addresses it. You may investigate further only after you have an edit in place.'

export async function runAgent({ prompt, workspace, messages: previousMessages = [], maxTurns = null, maxTokens = null, model = DEFAULT_MODEL, provider, signal, onEvent = () => {}, permissions = [], permissionMode = 'default', contextWindow = null, budgetTokens = null, sessionDir = null, resumeSessionId = null, sessionId = null, hooks = {}, agentDepth = 0, onPermissionRequest = null, microCompactKeepRecent = Number(process.env.MYCC_MICRO_COMPACT_KEEP ?? 0), commandRunner = null, displayWorkspace = null }) {
  // 显式 --context-window 优先,否则按模型解析(默认窗口不再是固定 200k 常量;
  // 源码 context.ts getContextWindowForModel 语义,P1-3)
  const effectiveContextWindow = contextWindow ?? getContextWindowForModel(model)
  let initial = previousMessages
  if (sessionDir && resumeSessionId) {
    initial = await resumeMessages(sessionDir, resumeSessionId)
  }
  const sessionRecorder = sessionDir ? createSessionRecorder({ dir: sessionDir, sessionId: sessionId ?? resumeSessionId ?? randomUUID(), cwd: workspace }) : null
  const messages = mergeConsecutiveUserMessages([...initial, { role: 'user', content: prompt }])
  const hookBase = extra => ({ session_id: sessionRecorder?.sessionId ?? 'unknown', transcript_path: '', cwd: workspace, permission_mode: permissionMode, ...extra })
  // Hook:SessionStart
  if (hooks?.SessionStart) {
    await executeHooks(hooks, 'SessionStart', hookBase({ hook_event_name: 'SessionStart' }))
  }
  // Hook:UserPromptSubmit(additionalContext 追加到首条 user 消息)
  if (hooks?.UserPromptSubmit) {
    const results = await executeHooks(hooks, 'UserPromptSubmit', hookBase({ prompt, hook_event_name: 'UserPromptSubmit' }))
    const contexts = collectAdditionalContext(results)
    if (contexts.length) {
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser) firstUser.content = [...asBlocks(firstUser.content), ...contexts.map(text => ({ type: 'text', text }))]
    }
  }
  if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
  const transcript = []
  let turns = 0
  let turnsSinceEdit = 0
  let finalText = ''
  let compactedCount = 0
  let compactFailures = 0
  const budgetTracker = createBudgetTracker()
  let cumulativeOutputTokens = 0
  const callModel = provider || createAnthropicProvider({ model })
  // max_tokens 策略:默认 32k(env 可覆盖到 64k),命中截断后 escalate 到 64k 并恢复
  // (源码 context.ts MAX_OUTPUT_TOKENS_DEFAULT / query.ts max_tokens recovery)
  let maxOutputTokens = maxTokens ?? getMaxOutputTokensForModel(model)
  let maxOutputTokensRecoveryCount = 0
  let maxTokensEscalated = false
  let termination = 'completed'
  // system prompt 在会话开始时构建一次(含 git status 快照与 CLAUDE.md),缓存复用
  // 保证 prompt cache 稳定,避免每轮重复执行 git 命令
  let systemPrompt = ''
  try {
    systemPrompt = await buildSystemPrompt({ workspace, displayWorkspace, model, tools: TOOL_DEFINITIONS, maxTurns })
  } catch (error) {
    systemPrompt = [
      'You are MyCC, a coding agent operating inside a user-provided repository.',
      'Inspect the repository, make the smallest targeted patch, and stop after the requested change is implemented.',
      maxTurns ? `You have at most ${maxTurns} tool-calling turns for this task. Budget them wisely: after initial investigation, start making edits — spending the entire turn budget on read-only exploration without producing a patch is a failure.` : '',
      workspace ? `Current workspace: ${displayWorkspace ?? workspace}` : '',
    ].filter(Boolean).join('\n')
  }
  // 子代理执行器(Agent 工具用):嵌套 runAgent,带深度限制,复用同一 provider 与策略
  const agentRunner = async subOptions => {
    if (agentDepth >= MAX_AGENT_DEPTH) throw new Error(`Agent nesting too deep (max ${MAX_AGENT_DEPTH})`)
    return runAgent({
      ...subOptions,
      provider,
      permissions,
      permissionMode,
      hooks,
      contextWindow: effectiveContextWindow,
      budgetTokens,
      signal,
      agentDepth: agentDepth + 1,
      onEvent: () => {},
      commandRunner,
      displayWorkspace,
    })
  }

  // token budget 续跑:返回 true 表示已注入 nudge 并应继续循环(tokenBudget.ts 语义)
  const budgetContinue = async () => {
    if (!budgetTokens) return false
    const decision = checkTokenBudget(budgetTracker, budgetTokens, cumulativeOutputTokens)
    if (decision.action === 'continue') {
      messages.push({ role: 'user', content: decision.nudgeMessage })
      if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
      transcript.push({ type: 'budget_nudge', turn: turns, message: decision.nudgeMessage })
      onEvent({ type: 'budget_nudge', turn: turns, message: decision.nudgeMessage })
      return true
    }
    return false
  }

  while (maxTurns == null || turns < maxTurns) {
    // microCompact:调用模型前清空较早 tool_result,保留最近 N 个(microCompact.ts 语义)
    if (microCompactKeepRecent > 0) {
      messages.splice(0, messages.length, ...microCompact(messages, { keepRecent: microCompactKeepRecent }))
    }
    // 上下文压缩检查(调用模型前,autoCompact.ts 语义);连续失败熔断
    const compactCheck = shouldCompact(messages, effectiveContextWindow, { model })
    if (compactCheck.action === 'compact' && compactFailures < MAX_COMPACT_FAILURES) {
      onEvent({ type: 'compact_start', turn: turns, usage: compactCheck.usage })
      try {
        const { messagesToSummarize, keepTail } = splitMessagesForCompact(messages)
        if (hooks?.PreCompact) await executeHooks(hooks, 'PreCompact', hookBase({ hook_event_name: 'PreCompact' }))
        const compacted = await compactMessages(messagesToSummarize, model, {
          summarizeFn: (summaryMessages, opts) => callModel({
            system: opts.system,
            messages: stripMessageMetadata(summaryMessages),
            tools: [],
            maxTokens: opts.maxOutputTokens,
            signal,
            onEvent: () => {}, // 摘要流不转发
          }),
          keepTail,
        })
        const attachments = await createPostCompactFileAttachments(workspace, {
          excludeFiles: readPathsFromMessages(keepTail),
        })
        if (attachments.length) {
          compacted.push({ role: 'user', content: attachments.map(attachment => ({ type: 'text', text: attachment.content })) })
        }
        // boundary 仅作 transcript 标记,不能进 API messages(Anthropic messages 只接受 user/assistant)
        const cleaned = mergeConsecutiveUserMessages(compacted.filter(m => m.role !== 'system'))
        messages.splice(0, messages.length, ...cleaned)
        compactFailures = 0
        compactedCount++
        onEvent({ type: 'compact_end', turn: turns, preTokens: compactCheck.usage, postTokens: estimateTokens(messages) })
        if (hooks?.PostCompact) await executeHooks(hooks, 'PostCompact', hookBase({ hook_event_name: 'PostCompact' }))
        if (sessionRecorder) {
          await sessionRecorder.recordCompactBoundary(compactCheck.usage)
          const summary = compacted.find(m => m.role === 'user' && m.isCompactSummary)
          if (summary) await sessionRecorder.record(summary)
        }
      } catch (error) {
        compactFailures++
        onEvent({ type: 'compact_failed', turn: turns, error: error instanceof Error ? error.message : String(error) })
      }
    }

    turns++
    // 强制收敛:连续 FORCE_EDIT_INTERVAL 轮无任何 Edit/Write 时注入提醒(只读死循环干预)
    if (maxTurns != null && turnsSinceEdit >= FORCE_EDIT_INTERVAL) {
      messages.push({ role: 'user', content: FORCE_EDIT_NUDGE })
      if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
      transcript.push({ type: 'force_edit_nudge', turn: turns, turnsSinceEdit })
      onEvent({ type: 'force_edit_nudge', turn: turns, turnsSinceEdit })
      turnsSinceEdit = 0
    }
    onEvent({ type: 'model_request', turn: turns })
    let response
    try {
      response = await callModel({
        system: systemPrompt,
        messages: stripMessageMetadata(messages),
        tools: TOOL_DEFINITIONS,
        maxTokens: maxOutputTokens,
        signal,
        onEvent: streamEvent => {
          // 流式文本增量实时转发
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
            onEvent({ type: 'assistant_text_delta', turn: turns, text: streamEvent.delta.text })
          }
        },
      })
    } catch (error) {
      // 流在已产出部分 content 后中断/出错(query.ts:955-996 语义):
      // 保留已收到的 assistant 消息,给每个 tool_use 补配对失败 tool_result,
      // 然后结束会话(源码 yieldMissingToolResultBlocks + return model_error)。
      // 否则直接抛出,由调用方(如 bench runner)分类为 agent_error。
      if (error instanceof StreamPartialError) {
        termination = 'model_error_partial'
        const partialContent = error.content ?? []
        const partialToolUses = extractToolUses(partialContent)
        if (partialContent.length > 0) {
          messages.push({ role: 'assistant', content: partialContent, usage: error.usage })
          if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
          transcript.push({ type: 'model_error_partial', turn: turns, toolUses: partialToolUses.length, error: error.message })
          onEvent({ type: 'model_error_partial', turn: turns, toolUses: partialToolUses.length, error: error.message })
        }
        if (partialToolUses.length > 0) {
          const toolResults = partialToolUses.map(toolUse => ({
            type: 'tool_result', tool_use_id: toolUse.id, content: error.message, is_error: true,
          }))
          messages.push({ role: 'user', content: toolResults })
          if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
          transcript.push({ type: 'model_error_tool_results', turn: turns, count: toolResults.length })
        }
        if (hooks?.Stop) await executeHooks(hooks, 'Stop', hookBase({ stop_hook_active: true, hook_event_name: 'Stop' }))
        break
      }
      throw new AgentRunError(error, {
        model,
        turns,
        finalText,
        transcript,
        messages,
        compactedCount,
        sessionId: sessionRecorder?.sessionId ?? null,
      })
    }
    const content = Array.isArray(response.content) ? response.content : []
    // 把真实 API usage 挂到 assistant 消息上,供 autocompact 用 usage 基线估算
    // (源码 utils/tokens.ts:201-260 以 canonical context usage 为基线)
    messages.push({ role: 'assistant', content, usage: response.usage })
    if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
    cumulativeOutputTokens += response.usage?.output_tokens ?? 0
    const text = extractText(content)
    if (text) {
      finalText = text
      transcript.push({ type: 'assistant_text', turn: turns, text })
      onEvent({ type: 'assistant_text', turn: turns, text })
    }
    const toolUses = extractToolUses(content)
    // stop_reason === 'max_tokens':输出被截断,先 escalate 一次(丢弃截断消息,
    // 以 64k 上限重放),再注入 continue 消息恢复,最多 3 次(源码 query.ts:1185-1255)
    if (response.stop_reason === 'max_tokens' && content.length > 0) {
      if (!maxTokensEscalated && maxOutputTokens < MAX_OUTPUT_TOKENS_ESCALATION_CAP) {
        maxTokensEscalated = true
        maxOutputTokens = MAX_OUTPUT_TOKENS_ESCALATION_CAP
        messages.pop() // 截断的 assistant 消息不进 history,直接重放
        transcript.push({ type: 'max_tokens_escalate', turn: turns })
        onEvent({ type: 'max_tokens_escalate', turn: turns })
        continue
      }
      if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        maxOutputTokensRecoveryCount++
        // 截断消息可能含未完成的 tool_use(API 要求 tool_use 必须紧跟 tool_result),
        // 替换为纯文本截断标记后再注入 continue 消息(源码以错误文本替代截断响应)
        messages[messages.length - 1] = { role: 'assistant', content: [{ type: 'text', text: '[Response exceeded the output token limit and was truncated.]' }] }
        messages.push({ role: 'user', content: 'Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.' })
        if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
        transcript.push({ type: 'max_tokens_recovery', turn: turns, count: maxOutputTokensRecoveryCount })
        onEvent({ type: 'max_tokens_recovery', turn: turns, count: maxOutputTokensRecoveryCount })
        continue
      }
      // 恢复耗尽:保留截断内容结束
      if (hooks?.Stop) await executeHooks(hooks, 'Stop', hookBase({ stop_hook_active: true, hook_event_name: 'Stop' }))
      break
    }
    if (!toolUses.length) {
      if (await budgetContinue()) continue
      if (hooks?.Stop) await executeHooks(hooks, 'Stop', hookBase({ stop_hook_active: true, hook_event_name: 'Stop' }))
      break
    }

    const toolResults = new Array(toolUses.length)
    const readToolIds = new Set()
    for (const batch of partitionToolCalls(toolUses)) {
      const runOne = async ({ toolUse, index }) => {
        onEvent({ type: 'tool_call', turn: turns, name: toolUse.name, input: toolUse.input })
        let result
        let isError = false
        let additionalContexts = []
        let effectiveInput = toolUse.input ?? {}
        // Hook:PreToolUse(可 block / 改输入 / 追加上下文)
        if (hooks?.PreToolUse) {
          const hookResults = await executeHooks(hooks, 'PreToolUse', hookBase({
            tool_name: toolUse.name, tool_input: effectiveInput, tool_use_id: toolUse.id, hook_event_name: 'PreToolUse',
          }))
          if (isBlocked(hookResults) || hookResults.some(hookResult => hookResult.decision === 'deny')) {
            result = { error: `Blocked by PreToolUse hook for ${toolUse.name}` }
            isError = true
          } else {
            if (hookResults[0]?.updatedInput) effectiveInput = { ...effectiveInput, ...hookResults[0].updatedInput }
            additionalContexts = collectAdditionalContext(hookResults)
          }
        }
        if (!isError) {
          try {
            result = await executeTool(toolUse.name, effectiveInput, { workspace, permissions, permissionMode, agentRunner, askHandler: onPermissionRequest, signal, commandRunner, displayWorkspace })
            if (hooks?.PostToolUse) {
              await executeHooks(hooks, 'PostToolUse', hookBase({
                tool_name: toolUse.name, tool_input: effectiveInput, tool_use_id: toolUse.id, tool_response: result, hook_event_name: 'PostToolUse',
              }))
            }
          } catch (error) {
            isError = true
            result = { error: error instanceof Error ? error.message : String(error) }
            if (hooks?.PostToolUseFailure) {
              await executeHooks(hooks, 'PostToolUseFailure', hookBase({
                tool_name: toolUse.name, tool_input: effectiveInput, tool_use_id: toolUse.id, tool_response: result, hook_event_name: 'PostToolUseFailure',
              }))
            }
          }
        }
        const serialized = await serializeToolResult(result, toolUse.name)
        if (READ_TOOL_NAMES.has(toolUse.name)) readToolIds.add(toolUse.id)
        const content = additionalContexts.length
          ? [...additionalContexts.map(text => ({ type: 'text', text })), { type: 'text', text: serialized }]
          : serialized
        toolResults[index] = { type: 'tool_result', tool_use_id: toolUse.id, content, is_error: isError }
        const entry = { type: 'tool_result', turn: turns, name: toolUse.name, input: effectiveInput, result, is_error: isError }
        transcript.push(entry)
        onEvent({ type: 'tool_result', turn: turns, name: toolUse.name, result, is_error: isError })
      }
      if (batch.isConcurrencySafe) {
        await Promise.all(batch.blocks.map(runOne))
      } else {
        for (const item of batch.blocks) await runOne(item)
      }
    }
    await enforceAggregateBudget(toolResults, readToolIds)
    messages.push({ role: 'user', content: toolResults })
    if (sessionRecorder) await sessionRecorder.record(messages.at(-1))
    // 更新"连续无修改"计数:本轮有 Edit/Write 则清零,否则 +1
    turnsSinceEdit = toolUses.some(tu => EDIT_TOOL_NAMES.has(tu.name)) ? 0 : turnsSinceEdit + 1
    if (await budgetContinue()) continue
  }

  if (maxTurns != null && turns >= maxTurns) {
    if (termination === 'completed') termination = 'max_turns'
    onEvent({ type: 'max_turns', turns })
    if (hooks?.Stop) await executeHooks(hooks, 'Stop', hookBase({ stop_hook_active: true, hook_event_name: 'Stop' }))
  }
  let diff = ''
  try {
    const result = await collectGitDiff(workspace)
    diff = result.diff || ''
  } catch {
    // A plain directory without git is still a valid local smoke-test target.
  }
  return { model, turns, finalText, transcript, diff, messages, compactedCount, termination, sessionId: sessionRecorder?.sessionId ?? null }
}
