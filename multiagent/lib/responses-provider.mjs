// OpenAI Responses API -> MyCC provider contract.
// Kept next to the multi-agent harness so it can run without the excluded bench/ tree.
import { StreamPartialError, parseSSEFrames } from '../../runtime/stream.mjs'

class APIHttpError extends Error {
  constructor(message, { status = null, retryAfter = null } = {}) {
    super(message)
    this.name = 'APIHttpError'
    this.status = status
    this.retryAfter = retryAfter
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function retryDelay(attempt, retryAfter) {
  const seconds = Number.parseInt(retryAfter ?? '', 10)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000
  const base = Math.min(500 * 2 ** (attempt - 1), 32_000)
  return base + Math.random() * base * 0.25
}

function combineSignals(...signals) {
  const controller = new AbortController()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    : ''
}

function toResponsesInput(messages) {
  const input = []
  for (const message of messages ?? []) {
    if (message.role === 'system') continue
    const content = Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: message.content ?? '' }]
    for (const block of content) {
      if (block.type === 'text' || block.type === 'input_text') {
        input.push({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: [{
            type: message.role === 'assistant' ? 'output_text' : 'input_text',
            text: block.text ?? '',
          }],
        })
      } else if (block.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        })
      } else if (block.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id,
          output: textFromContent(block.content),
        })
      }
    }
  }
  return input
}

function toResponsesTools(tools) {
  return (tools ?? []).map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    ...(tool.strict === true ? { strict: true } : {}),
  }))
}

function toContentBlocks(output) {
  const blocks = []
  for (const item of output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && part.text) blocks.push({ type: 'text', text: part.text })
      }
    } else if (item.type === 'function_call') {
      let input
      try {
        input = JSON.parse(item.arguments ?? '{}') ?? {}
      } catch {
        input = { raw: item.arguments }
      }
      blocks.push({ type: 'tool_use', id: item.call_id ?? item.id, name: item.name, input })
    }
  }
  return blocks
}

function toStopReason(status, output) {
  if (status === 'incomplete') return 'max_tokens'
  return output?.some(item => item.type === 'function_call') ? 'tool_use' : 'end_turn'
}

function toUsage(usage) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: usage?.output_tokens ?? 0,
  }
}

function parseArguments(raw) {
  try { return JSON.parse(raw) } catch { return { raw } }
}

function throwPartial(error, calls) {
  if (!calls.length) throw error
  throw new StreamPartialError(error?.message ?? String(error), {
    content: calls.map(call => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: parseArguments(call.arguments),
    })),
    cause: error,
  })
}

async function streamOnce({ endpoint, apiKey, body, signal, timeoutMs, onEvent }) {
  const timeout = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => timeout.abort(new Error('API timeout')), timeoutMs) : null
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: combineSignals(signal, timeout.signal),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new APIHttpError(`Responses API ${response.status}: ${(await response.text()).slice(0, 1_000)}`, {
        status: response.status,
        retryAfter: response.headers?.get?.('retry-after'),
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let finalResponse = null
    const partialCalls = []
    const partialById = new Map()
    // idle watchdog：每次 read 竞速一个无数据计时（半开连接/网关卡死时 abort+cancel，
    // 避免 reader.read() 永久挂起；与 runtime/stream.mjs 的 Anthropic 链路一致）
    const idleTimeoutMs = Number(process.env.MYCC_RESPONSES_IDLE_TIMEOUT_MS ?? 120_000)
    let idleTimer = null
    const readChunk = () => {
      let rejectIdle
      const idle = new Promise((_, reject) => {
        rejectIdle = reject
        idleTimer = setTimeout(() => {
          timeout.abort(new Error('Stream idle timeout - no chunks received'))
          reader.cancel().catch(() => {})
          reject(new Error('Stream idle timeout - no chunks received'))
        }, idleTimeoutMs)
      })
      return Promise.race([reader.read(), idle]).finally(() => clearTimeout(idleTimer))
    }
    try {
      while (true) {
        const { done, value } = await readChunk()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parsed = parseSSEFrames(buffer)
        buffer = parsed.remaining
        for (const frame of parsed.frames) {
          if (frame.data === '[DONE]') continue
          let event
          try { event = JSON.parse(frame.data) } catch { continue }
          if (event.type === 'response.completed' && event.response) finalResponse = event.response
          else if (event.type === 'response.incomplete' && event.response) finalResponse = event.response
          else if (event.type === 'response.output_text.delta') {
            onEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.delta ?? '' } })
          } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
            const call = {
              id: event.item.call_id ?? event.item.id,
              name: event.item.name,
              arguments: event.item.arguments ?? '',
            }
            partialCalls.push(call)
            partialById.set(event.item.id ?? call.id, call)
          } else if (event.type === 'response.function_call_arguments.delta' && partialById.has(event.item_id)) {
            partialById.get(event.item_id).arguments += event.delta ?? ''
          } else if (event.type === 'response.function_call_arguments.done' && partialById.has(event.item_id)) {
            partialById.get(event.item_id).arguments = event.arguments ?? partialById.get(event.item_id).arguments
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (error?.message?.includes('Stream idle timeout')) throw error
      if (timeout.signal.aborted) throw new Error('API timeout')
      throwPartial(error, partialCalls)
    } finally {
      reader.cancel().catch(() => {})
    }
    if (!finalResponse) throwPartial(new Error('Stream ended without response.completed'), partialCalls)
    return {
      role: 'assistant',
      content: toContentBlocks(finalResponse.output),
      stop_reason: toStopReason(finalResponse.status, finalResponse.output),
      usage: toUsage(finalResponse.usage),
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isRetryable(error, signal) {
  if (error instanceof StreamPartialError || signal?.aborted) return false
  if (error?.message?.includes('Stream idle timeout')) return true // 半开连接/网关停滞可重试
  if (error instanceof APIHttpError) return error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
  return error instanceof TypeError || error?.name === 'AbortError' || error?.message === 'API timeout'
}

export function createResponsesProvider({
  apiKey = process.env.MYCC_RESPONSES_API_KEY,
  baseUrl = process.env.MYCC_RESPONSES_BASE_URL || 'https://opencode.ai/zen/go',
  model = process.env.MYCC_RESPONSES_MODEL || 'deepseek-v4-flash',
  maxRetries = 5,
  timeoutMs = 300_000,
} = {}) {
  if (!apiKey) throw new Error('MYCC_RESPONSES_API_KEY is required for the Responses API provider')
  const endpoint = baseUrl.endsWith('/v1/responses') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/v1/responses`
  return async function streamResponses({ system, messages, tools, maxTokens, signal, onEvent = () => {} }) {
    const body = {
      model,
      input: toResponsesInput(messages),
      ...(system ? { instructions: typeof system === 'string' ? system : textFromContent(system) } : {}),
      tools: toResponsesTools(tools),
      max_output_tokens: maxTokens,
      stream: true,
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await streamOnce({ endpoint, apiKey, body, signal, timeoutMs, onEvent })
      } catch (error) {
        if (!isRetryable(error, signal) || attempt > maxRetries) throw error
        await sleep(retryDelay(attempt, error instanceof APIHttpError ? error.retryAfter : null))
      }
    }
  }
}
