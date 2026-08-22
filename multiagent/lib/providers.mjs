// multiagent/lib/providers.mjs
// 为 run-mab 提供统一的模型 provider；适配器与 multiagent 一起发布，避免依赖 bench/。
import { createResponsesProvider } from './responses-provider.mjs'
import { responsesConfig, loadEnv } from './env.mjs'

export function createProvider({ model } = {}) {
  const cfg = responsesConfig(loadEnv())
  return createResponsesProvider({
    model: model ?? cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
  })
}
