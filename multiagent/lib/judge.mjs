// multiagent/lib/judge.mjs
// 轻量 judge 调用：走 MyCC 的 Responses 端点（同 run-mab 的模型链路），
// SSE 流式解析 output_text；带超时与重试。judge 语义对齐官方 evaluator
// 的 model_prompting(max_token_num=4096, temperature=0.0)。
import { responsesConfig, loadEnv } from './env.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function judgeOnce(prompt, {
  model, baseUrl, apiKey, maxTokens = 4096, temperature = 0,
  timeoutMs = 180_000, maxRetries = 2, signal, onEvent = () => {},
} = {}) {
  const env = responsesConfig(loadEnv())
  model = model ?? env.model
  baseUrl = baseUrl ?? env.baseUrl
  apiKey = apiKey ?? env.apiKey
  const endpoint = baseUrl.replace(/\/$/, '') + '/v1/responses'
  const body = {
    model,
    input: prompt, // OpenAI Responses API 接受字符串 input
    max_output_tokens: maxTokens,
    temperature,
    stream: true,
  }
  let attempt = 0
  while (true) {
    attempt++
    const timeoutController = new AbortController()
    const timer = timeoutMs > 0 ? setTimeout(() => timeoutController.abort(new Error('judge timeout')), timeoutMs) : null
    let text = ''
    let usage = null
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 500)
        throw new Error(`judge HTTP ${res.status}: ${errText}`)
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        while (true) {
          const m = buf.match(/\r?\n\r?\n/)
          if (!m) break
          const i = m.index
          const frame = buf.slice(0, i)
          buf = buf.slice(i + m[0].length)
          const dataLine = frame.split('\n').find(l => l.startsWith('data:'))
          if (!dataLine) continue
          const data = dataLine.slice(5).trim()
          if (data === '[DONE]') continue
          let ev
          try { ev = JSON.parse(data) } catch { continue }
          if (ev.type === 'response.output_text.delta') {
            text += ev.delta ?? ''
            onEvent({ text: ev.delta ?? '' })
          } else if (ev.type === 'response.completed' && ev.response) {
            usage = ev.response.usage ?? null
          } else if (ev.type === 'response.incomplete' && ev.response) {
            // 网关对超长输入偶发：reasoning 流正常结束但未产出答案。
            // 记录 usage 供诊断，并让上层把空响应判为失败重试。
            usage = ev.response.usage ?? null
            onEvent({ type: 'response.incomplete' })
          } else if (ev.type === 'response.failed' && ev.response?.error) {
            throw new Error('judge response.failed: ' + JSON.stringify(ev.response.error).slice(0, 300))
          }
        }
      }
      // 空响应（只有 reasoning 无答案）视为失败，交给重试逻辑
      if (!text.trim()) {
        throw new Error(`judge returned empty output (attempt ${attempt})`)
      }
      return { text: text.trim(), usage, attempts: attempt }
    } catch (error) {
      if (attempt > maxRetries) throw error
      const retryable = !(signal?.aborted) && !(timeoutController.signal.aborted)
      if (!retryable) throw error
      await sleep(2000 * attempt)
    } finally {
      clearTimeout(timer)
    }
  }
}