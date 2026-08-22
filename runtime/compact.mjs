// runtime/compact.mjs
// 上下文压缩 + token 预算。移植自 src/services/compact/ 与 src/query/tokenBudget.ts 的
// 纯逻辑(常量与公式照搬),消息结构适配 runtime 的 Anthropic API 格式。

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
const WARNING_BUFFER_TOKENS = 20_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
const IMAGE_MAX_TOKEN_SIZE = 2000
const COMPACT_KEEP_RECENT_ROUNDS = 4
const COMPACT_KEEP_TAIL_TOKENS = 20_000

// ---------- token 估算(tokens.ts / tokenEstimation.ts) ----------

export function roughTokens(text, bytesPerToken = 4) {
  return Math.round(String(text ?? '').length / bytesPerToken)
}

function estimateBlockTokens(block) {
  if (typeof block === 'string') return roughTokens(block)
  if (!block || typeof block !== 'object') return roughTokens(JSON.stringify(block))
  switch (block.type) {
    case 'text': return roughTokens(block.text)
    case 'tool_use': return roughTokens(block.name + JSON.stringify(block.input ?? {}))
    case 'tool_result': {
      const content = block.content
      if (typeof content === 'string') return roughTokens(content)
      if (Array.isArray(content)) return content.reduce((sum, b) => sum + estimateBlockTokens(b), 0)
      return roughTokens(JSON.stringify(content ?? ''))
    }
    case 'image':
    case 'document': return IMAGE_MAX_TOKEN_SIZE
    case 'thinking': return roughTokens(block.thinking)
    case 'redacted_thinking': return roughTokens(block.data)
    default: return roughTokens(JSON.stringify(block))
  }
}

function estimateMessageTokens(message) {
  const content = message?.content
  if (!content) return 0
  if (typeof content === 'string') return roughTokens(content)
  if (Array.isArray(content)) return content.reduce((sum, b) => sum + estimateBlockTokens(b), 0)
  return roughTokens(JSON.stringify(content))
}

/** 整段消息数组的粗略 token 估算(字符数/4;image/document 固定 2000) */
export function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
}

/** 有最后一次真实 API usage 时:usage + 其后消息估算;否则全量估算 */
function tokenCountWithEstimation(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i]?.usage
    if (usage) {
      const usageTotal = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0) + (usage.output_tokens ?? 0)
      return usageTotal + estimateTokens(messages.slice(i + 1))
    }
  }
  return estimateTokens(messages)
}

// ---------- 阈值模型(autoCompact.ts:28-145) ----------

function isDeepSeekV4Flash(model) {
  const canonical = String(model ?? '').trim()
  return /(?:^|[/:])deepseek-v4-flash$/i.test(canonical)
}

/**
 * 上下文窗口:按模型解析,对齐 src/utils/context.ts:51-98。
 * 优先级:CLAUDE_CODE_MAX_CONTEXT_TOKENS 覆盖 > [1m] 后缀 > 已知模型能力
 * (DeepSeek V4 Flash 1M) > 默认 200k。benchmark runner 可用 --context-window
 * 显式固定,优先级最高。Claude 不会仅因模型名自动启用 1M。
 */
export function getContextWindowForModel(model) {
  const override = Number(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS)
  if (Number.isFinite(override) && override > 0) return override
  if (/\[1m\]/i.test(model ?? '')) return 1_000_000
  if (isDeepSeekV4Flash(model)) return 1_000_000
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/** 模型最大输出(简化默认 32k,env 可覆盖) */
export function getMaxOutputTokensForModel() {
  const override = Number(process.env.MYCC_MAX_OUTPUT_TOKENS)
  if (Number.isFinite(override) && override > 0) return Math.min(override, 64_000)
  return 32_000
}

export function getEffectiveContextWindowSize(model, contextWindow) {
  const reserved = Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY)
  return (contextWindow ?? getContextWindowForModel(model)) - reserved
}

export function getAutoCompactThreshold(model) {
  return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
}

/**
 * 压缩决策:
 *  - none     未到 warning 线
 *  - warn     超过 warning 线(threshold - 20k)
 *  - compact  超过 autocompact 线(threshold)
 *  - block    超过 blocking 线(effective - 3k,仅 autoCompact 关闭时使用)
 */
export function shouldCompact(messages, contextWindow, { model, autoCompactEnabled = true, snipTokensFreed = 0 } = {}) {
  const effective = getEffectiveContextWindowSize(model ?? 'default', contextWindow)
  const threshold = autoCompactEnabled ? effective - AUTOCOMPACT_BUFFER_TOKENS : effective
  const usage = tokenCountWithEstimation(messages) - (snipTokensFreed || 0)
  const percentLeft = Math.max(0, Math.round(((threshold - usage) / threshold) * 100))
  // blocking 分支仅在 auto-compact 关闭时使用(否则直接进 compact 分支,autoCompact.ts:103-121)
  if (!autoCompactEnabled && usage >= effective - MANUAL_COMPACT_BUFFER_TOKENS) return { action: 'block', usage, threshold, percentLeft }
  if (autoCompactEnabled && usage >= threshold) return { action: 'compact', usage, threshold, percentLeft }
  if (usage >= threshold - WARNING_BUFFER_TOKENS) return { action: 'warn', usage, threshold, percentLeft }
  return { action: 'none', usage, threshold, percentLeft }
}

// ---------- 摘要 prompt(prompt.ts 简化版) ----------

export function buildCompactPrompt(customInstructions) {
  const base = [
    'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
    "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
    'Wrap your analysis in <analysis> tags; then output a <summary> with these sections:',
    '1. Primary Request and Intent',
    '2. Key Technical Concepts',
    '3. Files and Code Sections (include full code snippets)',
    '4. Errors and fixes',
    '5. Problem Solving',
    '6. All user messages (not tool results)',
    '7. Pending Tasks',
    '8. Current Work (details of the most recent work)',
    '9. Optional Next Step (quote the most recent conversation verbatim)',
    'Output: <analysis>...</analysis> then <summary>...</summary>',
  ].join('\n\n')
  return base
    + (customInstructions ? `\n\nAdditional Instructions:\n${customInstructions}` : '')
    + '\n\nREMINDER: Do NOT call any tools. Respond with plain text only.'
}

export function formatSummary(raw) {
  let s = raw.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const m = s.match(/<summary>([\s\S]*?)<\/summary>/)
  if (m) s = s.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${m[1].trim()}`)
  return s.replace(/\n\n+/g, '\n\n').trim()
}

/**
 * 异步压缩:调用 summarizeFn 生成摘要,返回 [boundary, summary, ...keepTail]。
 * messages 为 Anthropic API 格式。
 * @param {object[]} messages
 * @param {(promptMessages: object[], opts: { system: string, maxOutputTokens: number }) => Promise<{ content: object[] }>} summarizeFn
 */
export async function compactMessages(messages, model, { summarizeFn, customInstructions, suppressFollowUpQuestions = true, keepTail = [] } = {}) {
  const preCompactTokenCount = tokenCountWithEstimation(messages)
  const prompt = buildCompactPrompt(customInstructions)
  const boundaryMarker = {
    role: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: new Date().toISOString(),
    compactMetadata: { trigger: 'auto', preTokens: preCompactTokenCount },
  }
  // 摘要请求:原消息 + 追加摘要指令;禁用工具
  const summaryMessages = [
    ...messages,
    { role: 'user', content: prompt },
  ]
  const rawResponse = await summarizeFn(summaryMessages, {
    system: 'You are a helpful AI assistant tasked with summarizing conversations.',
    maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS_FOR_SUMMARY, getMaxOutputTokensForModel(model)),
  })
  const raw = extractText(rawResponse)
  const body = 'This session is being continued from a previous conversation that ran out of context. '
    + 'The summary below covers the earlier portion of the conversation.\n\n'
    + formatSummary(raw)
    + (suppressFollowUpQuestions
      ? '\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.'
      : '')
  const summaryMessage = { role: 'user', isCompactSummary: true, content: body }
  return [boundaryMarker, summaryMessage, ...keepTail]
}

/** Runtime stores one assistant message per API response, so each assistant starts a new API round. */
export function groupMessagesByApiRound(messages) {
  const groups = []
  let current = []
  for (const message of messages) {
    if (message.role === 'assistant' && current.length > 0) {
      groups.push(current)
      current = [message]
    } else {
      current.push(message)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Split at complete API-round boundaries and summarize only the removed prefix. */
export function splitMessagesForCompact(messages, { keepRecentRounds = COMPACT_KEEP_RECENT_ROUNDS, maxTailTokens = COMPACT_KEEP_TAIL_TOKENS } = {}) {
  const groups = groupMessagesByApiRound(trimUnclosedToolUse(messages))
  let cut = groups.length
  let tailTokens = 0
  let keptRounds = 0
  while (cut > 1 && keptRounds < keepRecentRounds) {
    const candidateTokens = estimateTokens(groups[cut - 1])
    if (tailTokens + candidateTokens > maxTailTokens) break
    tailTokens += candidateTokens
    keptRounds++
    cut--
  }
  return {
    messagesToSummarize: groups.slice(0, cut).flat(),
    keepTail: groups.slice(cut).flat(),
  }
}

function extractText(response) {
  const content = response?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')
  }
  return ''
}

// ---------- token budget 续跑(tokenBudget.ts:45-93) ----------

export function createBudgetTracker() {
  return { continuationCount: 0, lastDeltaTokens: 0, lastGlobalTurnTokens: 0, startedAt: Date.now() }
}

export function checkTokenBudget(tracker, budget, globalTurnTokens) {
  if (budget === null || budget === undefined || budget <= 0) return { action: 'stop' }
  const pct = Math.round((globalTurnTokens / budget) * 100)
  const delta = globalTurnTokens - tracker.lastGlobalTurnTokens
  const diminishing = tracker.continuationCount >= 3 && delta < 500 && tracker.lastDeltaTokens < 500
  if (!diminishing && globalTurnTokens < budget * 0.9) {
    tracker.continuationCount++
    tracker.lastDeltaTokens = delta
    tracker.lastGlobalTurnTokens = globalTurnTokens
    return {
      action: 'continue',
      nudgeMessage: `Stopped at ${pct}% of token target (${globalTurnTokens.toLocaleString('en-US')} / ${budget.toLocaleString('en-US')}). Keep working — do not summarize.`,
    }
  }
  return { action: 'stop', diminishing }
}

// ---------- 消息卫生(compact/resume 后使用) ----------

const OLD_TOOL_RESULT_MARKER = '[Old tool result content cleared]'

/**
 * microCompact(microCompact.ts 语义):不调用 LLM,把较早的 tool_result 内容
 * 清空为 marker、保留消息骨架;只保留最近 keepRecent 个完整结果。
 * @param {object[]} messages Anthropic API 格式
 * @param {{ keepRecent?: number }} [opts]
 * @returns {object[]} 新数组(元素浅拷贝,content 内 tool_result 被替换)
 */
export function microCompact(messages, { keepRecent = 5 } = {}) {
  const result = messages.map(m => ({ ...m }))
  const blocks = []
  for (let i = 0; i < result.length; i++) {
    const msg = result[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (let j = 0; j < msg.content.length; j++) {
      if (msg.content[j]?.type === 'tool_result') blocks.push({ i, j })
    }
  }
  const keepFrom = Math.max(0, blocks.length - keepRecent)
  for (let k = 0; k < blocks.length; k++) {
    if (k < keepFrom) {
      result[blocks[k].i].content[blocks[k].j] = {
        ...result[blocks[k].i].content[blocks[k].j],
        content: OLD_TOOL_RESULT_MARKER,
      }
    }
  }
  return result
}

/** 裁剪末尾未闭合的 tool_use(assistant 最后有 tool_use 却无对应 tool_result,API 会 400) */
export function trimUnclosedToolUse(messages) {
  const result = [...messages]
  while (result.length) {
    const last = result.at(-1)
    const hasUnclosedToolUse = last?.role === 'assistant' && Array.isArray(last.content) && last.content.some(block => block?.type === 'tool_use')
    if (hasUnclosedToolUse) result.pop()
    else break
  }
  return result
}

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content
  return []
}

/** 合并相邻 user 消息(src normalizeMessagesForAPI 同样合并连续 user) */
export function mergeConsecutiveUserMessages(messages) {
  const result = []
  for (const message of messages) {
    const last = result.at(-1)
    if (last?.role === 'user' && message.role === 'user') {
      last.content = [...contentBlocks(last.content), ...contentBlocks(message.content)]
    } else {
      result.push({ ...message })
    }
  }
  return result
}
