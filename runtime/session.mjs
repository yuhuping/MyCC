// runtime/session.mjs
// 会话持久化:jsonl transcript 落盘 + resume。移植自 src/utils/sessionStorage.ts /
// sessionStoragePortable.ts 的契约(append-only、parentUuid 链、0o600、坏行容错),
// 裁剪 bootstrap/state、analytics、hooks、远程持久化等全部耦合。

import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { trimUnclosedToolUse } from './compact.mjs'

export function configDir() {
  return (process.env.MYCC_CONFIG_DIR ?? path.join(homedir(), '.mycc')).normalize('NFC')
}

function djb2Hash(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0
  return hash
}

// 非 [a-zA-Z0-9] 全替换为 '-';超 200 截断 + hash 后缀(portable.ts:293-319)
export function sanitizePath(input) {
  const sanitized = String(input).replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= 200) return sanitized
  return `${sanitized.slice(0, 200)}-${djb2Hash(sanitized).toString(36)}`
}

export function projectDir(cwd) {
  return path.join(configDir(), 'projects', sanitizePath(path.resolve(cwd)))
}

// sessionId 消毒:仅允许字母数字与 . _ -(防 --session-id ../x 路径穿越)
function sanitizeSessionId(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '-')
}

export function transcriptPath(dir, sessionId) {
  return path.join(dir, `${sanitizeSessionId(sessionId)}.jsonl`)
}

/** 追加一条 transcript entry;目录 0o700、文件 0o600、append-only */
export async function appendTranscript(dir, sessionId, entry) {
  const file = transcriptPath(dir, sessionId)
  const line = JSON.stringify(entry) + '\n'
  try {
    await fs.appendFile(file, line, { mode: 0o600 })
  } catch {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.appendFile(file, line, { mode: 0o600 })
  }
}

/** 读取全部 entry;坏行跳过不抛错(json.ts:129-153) */
export async function readTranscript(dir, sessionId) {
  const file = transcriptPath(dir, sessionId)
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const entries = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 容错坏行
    }
  }
  return entries
}

/** 目录下最新会话 id(按 mtime);无会话返回 null */
export async function newestSessionId(dir) {
  const sessions = await listSessions(dir)
  return sessions[0]?.sessionId ?? null
}

/** 列出全部会话:id / 更新时间 / 消息数,按更新时间倒序 */
export async function listSessions(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const sessions = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const sessionId = name.replace(/\.jsonl$/, '')
    const file = path.join(dir, name)
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      continue
    }
    const entries = await readTranscript(dir, sessionId)
    sessions.push({
      sessionId,
      updatedAt: stat.mtimeMs,
      messageCount: entries.filter(entry => entry.type === 'user' || entry.type === 'assistant').length,
    })
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

/**
 * 线性恢复:从最后一个 compact_boundary 之后取 user/assistant 消息,
 * 返回 Anthropic API 格式消息数组。
 */
export async function resumeMessages(dir, sessionId) {
  const entries = await readTranscript(dir, sessionId)
  let startIndex = 0
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === 'system' && entries[i].subtype === 'compact_boundary') startIndex = i + 1
  }
  return trimUnclosedToolUse(
    entries
      .slice(startIndex)
      .filter(entry => entry.type === 'user' || entry.type === 'assistant')
      .map(entry => entry.message),
  )
}

/**
 * 会话记录器:包装 append,维护 parentUuid 链(用户消息的下一链指针 =
 * 前一条链参与者消息的 uuid;compact_boundary 强制 null 截断)。
 */
export function createSessionRecorder({ dir, sessionId = randomUUID(), cwd }) {
  let lastUuid = null
  return {
    sessionId,
    async record(message) {
      const entry = {
        parentUuid: lastUuid,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        type: message.role,
        subtype: message.isCompactSummary ? 'compact_summary' : undefined,
        message,
      }
      await appendTranscript(dir, sessionId, entry)
      lastUuid = entry.uuid
    },
    async recordCompactBoundary(preTokens) {
      const entry = {
        parentUuid: null,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId,
        cwd,
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens },
      }
      await appendTranscript(dir, sessionId, entry)
      lastUuid = null
    },
  }
}
