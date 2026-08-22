// runtime/stream.mjs
// Claude Messages API SSE 流式调用。移植自 src/services/api/claude.ts 的
// queryModelWithStreaming 事件状态机与 src/cli/transports/SSETransport.ts 的帧解析,
// 裁剪了 SDK 依赖、fallback 链、analytics 等全部环境耦合。
// 对齐了 withRetry.ts 的 transient retry(指数退避 + 25% jitter + Retry-After、
// 最多 10 次、529 连续 3 次上限)与 stream idle watchdog / 总请求超时,
// 以及 claude.ts 按模型启用的 adaptive/budget thinking。

const ANTHROPIC_VERSION = '2023-06-01'
const EMPTY_USAGE = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
}

// ---------- retry / timeout 常量(withRetry.ts:52-55, claude.ts:1868-1929) ----------
const DEFAULT_MAX_RETRIES = 10
const BASE_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 32_000
const MAX_529_RETRIES = 3
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000
const DEFAULT_API_TIMEOUT_MS = 300_000

class APIHttpError extends Error {
  constructor(message, { status = null, retryAfter = null, overloaded = false } = {}) {
    super(message)
    this.name = 'APIHttpError'
    this.status = status
    this.retryAfter = retryAfter
    this.overloaded = overloaded
  }
}

// SSE 流在已产出部分 content(可能含 tool_use)后中断/出错时抛出,
// 携带已收到的 content blocks 供上层补配对 tool_result(query.ts:984,1025
// yieldMissingToolResultBlocks 语义)。不被 retry 循环捕获——部分响应已消费,
// 重试无意义。
export class StreamPartialError extends Error {
  constructor(message, { content = [], stopReason = null, usage = null, cause } = {}) {
    super(message, { cause })
    this.name = 'StreamPartialError'
    this.content = content
    this.stopReason = stopReason
    this.usage = usage
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRetryDelay(attempt, retryAfterHeader, baseDelayMs = BASE_DELAY_MS) {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  }
  const base = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)
  return base + Math.random() * 0.25 * base
}

function combineSignals(...signals) {
  const controller = new AbortController()
  for (const s of signals) {
    if (!s) continue
    if (s.aborted) {
      controller.abort(s.reason)
      return controller.signal
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true })
  }
  return controller.signal
}

// thinking 配置:claude.ts:1596-1630 语义。
// 支持 adaptive 的模型(4-6 系列)用 {type:'adaptive'};仅支持 budget 的 Claude 4
// 系列用 {type:'enabled', budget_tokens};env MYCC_THINKING=adaptive|enabled|disabled 覆盖。
function getThinkingConfig(model, maxTokens) {
  const env = (process.env.MYCC_THINKING ?? '').toLowerCase()
  if (env === 'disabled') return undefined
  const m = model ?? ''
  const supportsAdaptive = env === 'adaptive' || /claude-(opus|sonnet|haiku)-4-6/.test(m)
  const supportsThinking = supportsAdaptive || /claude-(opus|sonnet|haiku)-4/.test(m)
  if (!supportsThinking) return undefined
  if (supportsAdaptive) return { type: 'adaptive' }
  return { type: 'enabled', budget_tokens: Math.max(1, Math.min(maxTokens - 1, 63_999)) }
}

// ---------- SSE 帧解析(SSETransport.ts:46-116 照搬) ----------

export function parseSSEFrames(buffer) {
  const frames = []
  let pos = 0
  let idx
  while ((idx = buffer.indexOf('\n\n', pos)) !== -1) {
    const rawFrame = buffer.slice(pos, idx)
    pos = idx + 2
    if (!rawFrame.trim()) continue
    const frame = {}
    let isComment = false
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) { isComment = true; continue }
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const field = line.slice(0, colonIdx)
      const value = line[colonIdx + 1] === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1)
      switch (field) {
        case 'event': frame.event = value; break
        case 'id': frame.id = value; break
        case 'data': frame.data = frame.data ? frame.data + '\n' + value : value; break
      }
    }
    if (frame.data || isComment) frames.push(frame)
  }
  return { frames, remaining: buffer.slice(pos) }
}

function safeParseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

// 出错但已收到部分 content 时包装为 StreamPartialError,否则原样抛出
function throwOrPartial(error, state) {
  if (state?.contentBlocks?.length > 0) {
    throw new StreamPartialError(error?.message ?? String(error), {
      content: state.contentBlocks,
      stopReason: state.stopReason,
      usage: state.usage,
      cause: error,
    })
  }
  throw error
}

function updateUsage(usage, part) {
  const next = { ...usage }
  if (part?.input_tokens > 0) next.input_tokens = part.input_tokens
  if (part?.cache_creation_input_tokens > 0) next.cache_creation_input_tokens = part.cache_creation_input_tokens
  if (part?.cache_read_input_tokens > 0) next.cache_read_input_tokens = part.cache_read_input_tokens
  if (part?.output_tokens > 0) next.output_tokens = part.output_tokens
  return next
}

// ---------- 事件状态机(claude.ts:1979-2304 裁剪版) ----------

function handleEvent(part, state, onEvent) {
  switch (part.type) {
    case 'message_start':
      state.partialMessage = part.message
      state.ttftMs = Date.now() - state.start
      state.usage = updateUsage(state.usage, part.message?.usage)
      onEvent({ type: 'message_start', message: part.message, ttftMs: state.ttftMs })
      break
    case 'content_block_start': {
      // ★ 清空 start 事件里预置的文本/input(claude.ts:2019-2050 的 SDK 重复文本问题)
      const block = part.content_block
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        state.contentBlocks[part.index] = { ...block, input: '' }
      } else if (block.type === 'text') {
        state.contentBlocks[part.index] = { ...block, text: '' }
      } else if (block.type === 'thinking') {
        state.contentBlocks[part.index] = { ...block, thinking: '', signature: '' }
      } else {
        state.contentBlocks[part.index] = { ...block }
      }
      onEvent({ type: 'content_block_start', index: part.index, content_block: state.contentBlocks[part.index] })
      break
    }
    case 'content_block_delta': {
      const cb = state.contentBlocks[part.index]
      if (!cb) throw new RangeError(`Content block not found: ${part.index}`)
      switch (part.delta.type) {
        case 'text_delta': cb.text += part.delta.text; break
        case 'thinking_delta': cb.thinking += part.delta.thinking; break
        case 'signature_delta': cb.signature = part.delta.signature; break // 覆盖不是累加
        case 'input_json_delta': cb.input += part.delta.partial_json; break // 到 stop 才 parse
        case 'citations_delta': break
        default: break
      }
      onEvent({ type: 'content_block_delta', index: part.index, delta: part.delta })
      break
    }
    case 'content_block_stop': {
      const cb = state.contentBlocks[part.index]
      if (!cb) throw new RangeError(`Content block not found: ${part.index}`)
      // tool_use 的 input 在此从字符串 parse 成对象;失败退化为 {}
      if ((cb.type === 'tool_use' || cb.type === 'server_tool_use') && typeof cb.input === 'string') {
        cb.input = safeParseJson(cb.input) ?? {}
      }
      onEvent({ type: 'content_block_stop', index: part.index, content_block: cb })
      break
    }
    case 'message_delta':
      state.usage = updateUsage(state.usage, part.usage)
      state.stopReason = part.delta?.stop_reason ?? null
      onEvent({ type: 'message_delta', delta: part.delta, usage: state.usage })
      break
    case 'message_stop':
      onEvent({ type: 'message_stop' })
      break
    case 'ping':
      break // 忽略
    case 'error':
      // overloaded_error 可重试;其余 API error 直接抛出(带状态)
      throw new APIHttpError(
        `${part.error?.type ?? 'api_error'}: ${part.error?.message ?? 'unknown error'}`,
        { overloaded: part.error?.type === 'overloaded_error' },
      )
    default:
      break // 未知类型必须优雅忽略(官方 versioning 政策)
  }
}

/**
 * 单次流式请求(不做 retry)。返回最终 assistant message。
 */
async function streamOnce({ cleanBaseUrl, apiKey, body, signal, watchdogEnabled, idleTimeoutMs, totalTimeoutMs, onEvent }) {
  const abortSignals = [signal]
  const timeoutController = new AbortController()
  let totalTimer = null
  if (totalTimeoutMs > 0) {
    totalTimer = setTimeout(() => timeoutController.abort(new Error('API timeout')), totalTimeoutMs)
    abortSignals.push(timeoutController.signal)
  }
  let watchdogTimer = null
  const watchdogController = new AbortController()
  if (watchdogEnabled && idleTimeoutMs > 0) {
    abortSignals.push(watchdogController.signal)
  }
  const resetWatchdog = () => {
    if (!watchdogEnabled) return
    if (watchdogTimer) clearTimeout(watchdogTimer)
    watchdogTimer = setTimeout(() => watchdogController.abort(new Error('Stream idle timeout - no chunks received')), idleTimeoutMs)
  }
  try {
    const response = await fetch(`${cleanBaseUrl}/v1/messages`, {
      method: 'POST',
      signal: combineSignals(...abortSignals),
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const bodyText = await response.text()
      throw new APIHttpError(`Anthropic API ${response.status}: ${bodyText.slice(0, 1_000)}`, {
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after') ?? null,
      })
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const state = {
      partialMessage: null,
      contentBlocks: [],
      usage: { ...EMPTY_USAGE },
      stopReason: null,
      start: Date.now(),
    }
    resetWatchdog()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetWatchdog()
        buffer += decoder.decode(value, { stream: true })
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining
        for (const frame of frames) {
          if (!frame.data) continue
          try {
            handleEvent(JSON.parse(frame.data), state, onEvent)
          } catch (error) {
            // 坏帧跳过,不中断整个流(代理偶发垃圾帧)
            if (error instanceof SyntaxError) continue
            throw error
          }
        }
      }
    } catch (error) {
      // 内部 watchdog/总超时 abort:转成普通 Error 抛出,不能被 retry 循环误判为瞬态
      if (watchdogController.signal.aborted) throwOrPartial(new Error('Stream idle timeout - no chunks received'), state)
      if (timeoutController.signal.aborted) throwOrPartial(new Error('API timeout'), state)
      if (signal?.aborted) throwOrPartial(new DOMException('Aborted', 'AbortError'), state)
      throwOrPartial(error, state)
    } finally {
      // 无论正常/异常/abort 都要释放资源(claude.ts:1519-1526)
      reader.cancel().catch(() => {})
    }
    // 流结束但无任何消息 = 代理/网关异常(无部分内容,直接抛原错误)
    if (!state.partialMessage || (state.contentBlocks.length === 0 && !state.stopReason)) {
      throw new Error('Stream ended without receiving any events')
    }
    return {
      role: 'assistant',
      content: state.contentBlocks,
      stop_reason: state.stopReason,
      usage: state.usage,
    }
  } finally {
    if (totalTimer) clearTimeout(totalTimer)
    if (watchdogTimer) clearTimeout(watchdogTimer)
  }
}

/**
 * 流式调用 Claude Messages API,返回最终 assistant message。
 * 带 transient retry(指数退避 + jitter + Retry-After)与可选的 idle watchdog / 总超时。
 * @param {{ apiKey?: string, model?: string, baseUrl?: string, promptCaching?: boolean,
 *           maxRetries?: number, idleTimeoutMs?: number, apiTimeoutMs?: number }} opts
 */
export function createStreamingProvider({ apiKey, model, baseUrl, promptCaching, maxRetries, baseDelayMs, idleTimeoutMs, apiTimeoutMs }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required. Use --demo to validate the local loop without a model.')
  const cleanBaseUrl = (baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
  const cacheEnabled = promptCaching ?? /^(1|true|yes)$/i.test(process.env.MYCC_PROMPT_CACHE ?? '')
  const retryLimit = maxRetries ?? Number(process.env.MYCC_MAX_RETRIES ?? process.env.CLAUDE_CODE_MAX_RETRIES ?? DEFAULT_MAX_RETRIES)
  const retryBaseDelay = baseDelayMs ?? BASE_DELAY_MS
  const watchdogEnabled = /^(1|true|yes)$/i.test(process.env.CLAUDE_ENABLE_STREAM_WATCHDOG ?? '')
  const idleTimeout = idleTimeoutMs ?? Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  const totalTimeout = apiTimeoutMs ?? Number(process.env.API_TIMEOUT_MS ?? DEFAULT_API_TIMEOUT_MS)

  return async function streamMessages({ system, messages, tools, maxTokens, signal, onEvent = () => {} }) {
    // prompt caching:system 包成带 cache_control 的 block,最后一个工具加断点(claude.ts buildSystemPromptBlocks 语义)
    const systemBody = cacheEnabled && typeof system === 'string'
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system
    const toolsBody = cacheEnabled && Array.isArray(tools) && tools.length
      ? tools.map((tool, index, all) => index === all.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool)
      : tools
    const thinking = getThinkingConfig(model, maxTokens)
    const body = {
      model,
      max_tokens: maxTokens,
      stream: true,
      system: systemBody,
      messages,
      tools: toolsBody,
      ...(thinking ? { thinking } : {}),
    }

    let attempt = 1
    let consecutive529 = 0
    while (true) {
      try {
        return await streamOnce({ cleanBaseUrl, apiKey, body, signal, watchdogEnabled, idleTimeoutMs: idleTimeout, totalTimeoutMs: totalTimeout, onEvent })
      } catch (error) {
        const isHttp = error instanceof APIHttpError
        // 部分响应已消费:不再重试,直接抛给上层补 tool_result
        if (error instanceof StreamPartialError) throw error
        const status = isHttp ? error.status : null
        const overloaded = isHttp ? error.overloaded : false
        if (overloaded) consecutive529++
        else consecutive529 = 0
        const retryable = isHttp
          ? (status === 408 || status === 409 || status === 429 || status >= 500) || overloaded
          : error instanceof TypeError || (error?.name === 'AbortError' && signal?.aborted === false)
        if (!retryable || attempt > retryLimit || (consecutive529 > MAX_529_RETRIES && overloaded)) {
          throw error
        }
        const delay = getRetryDelay(attempt, isHttp ? error.retryAfter : null, retryBaseDelay)
        await sleep(delay)
        attempt++
      }
    }
  }
}
