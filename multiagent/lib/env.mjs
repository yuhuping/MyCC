// multiagent/lib/env.mjs
// 读取 MyCC 根目录 .env；供 judge / run-mab 复用（不打印密钥）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

export function loadEnv(root = ROOT) {
  if (cached) return cached
  const env = { ...process.env }
  const envPath = path.join(root, '.env')
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const l = line.trim()
      if (!l || l.startsWith('#')) continue
      const i = l.indexOf('=')
      if (i === -1) continue
      const k = l.slice(0, i).trim()
      const v = l.slice(i + 1).trim().replace(/^["']|["']$/g, '')
      if (k && !(k in env)) env[k] = v
    }
  }
  cached = env
  return env
}

export const ROOT_DIR = ROOT

export function responsesConfig(env = loadEnv()) {
  const apiKey = env.MYCC_RESPONSES_API_KEY || env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('MYCC_RESPONSES_API_KEY is required in .env')
  return {
    apiKey,
    baseUrl: env.MYCC_RESPONSES_BASE_URL || 'https://opencode.ai/zen/go',
    model: env.MYCC_RESPONSES_MODEL || 'deepseek-v4-flash',
  }
}