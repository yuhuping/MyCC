// multiagent/lib/artifacts.mjs
// Node 产物契约（Audit §5）：schema 校验、原子写、SHA256、路径越界检查、下游摘要。
//
// 每个 node 的结构化交付物只存在于专属目录（out/artifacts/<taskId>/<nodeId>/），
// 由 coordinator 从 agent finalText 中的 JSON 块提取并原子落盘；patch.diff 由
// worktree 采集。下游只消费校验过的 artifact 摘要，绝不拼接完整 finalText。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export class ArtifactError extends Error {
  constructor(message, errors = []) {
    super(message)
    this.name = 'ArtifactError'
    this.errors = Array.isArray(errors) ? errors : [String(errors)]
  }
}

// ---------------------------------------------------------------- hash

export function sha256Text(text) {
  return crypto.createHash('sha256').update(typeof text === 'string' ? text : JSON.stringify(text), 'utf8').digest('hex')
}

export function sha256File(file) {
  return sha256Text(fs.readFileSync(file, 'utf8'))
}

// ---------------------------------------------------------------- 原子写

/** 原子写 JSON：先写临时文件再 rename，防止半写入。 */
export function atomicWriteJson(dir, filename, obj) {
  const target = path.join(dir, filename)
  assertPathInside(dir, target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`)
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n')
  fs.renameSync(tmp, target)
  return target
}

// ---------------------------------------------------------------- 越界检查

/** target 的绝对路径必须位于 base 之内；否则抛 ArtifactError（audit §4 路径逃逸规则）。 */
export function assertPathInside(base, target) {
  const b = path.resolve(base)
  const t = path.resolve(target)
  if (t !== b && !t.startsWith(b + path.sep)) {
    throw new ArtifactError(`path escapes artifact dir: ${target}`, [`${target} not inside ${base}`])
  }
}

// ---------------------------------------------------------------- 结构化提取

/**
 * 从 agent 的 finalText 提取行末 JSON 块（```json ... ``` 栅栏，或末尾独立 JSON 对象）。
 * 提取失败返回 null —— 对应「缺失 artifact」fail-fast，绝不猜。
 */
export function extractStructuredArtifact(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  // 1) 最后一个 ```json fence
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g
  let last = null
  let m
  while ((m = fenceRe.exec(text)) !== null) last = m
  if (last) {
    try {
      const obj = JSON.parse(last[1].trim())
      if (obj && typeof obj === 'object') return obj
    } catch { /* fall through */ }
  }
  // 2) 从头/尾部独立 JSON 对象（允许前后有说明文字）
  const objRe = /\{[\s\S]*\}/g
  let lastObj = null
  while ((m = objRe.exec(text)) !== null) lastObj = m
  if (lastObj) {
    try {
      const obj = JSON.parse(lastObj[0])
      if (obj && typeof obj === 'object') return obj
    } catch { /* fall through */ }
  }
  return null
}

// ---------------------------------------------------------------- schema

// 每类 node 必须交付的 artifact 文件（Audit §5 Node 产物契约）
export const REQUIRED_ARTIFACTS = {
  lead: ['lead.json'],
  implement: ['implementation.json'],
  review: ['review.json'],
  test_review: ['test-plan.json'],
  patch: ['patch.json', 'patch.diff'],
  integrate: ['integration.json'],
  verify: ['verification.json'],
}

const SEVERITIES = new Set(['critical', 'major', 'minor', 'info'])

const isStr = v => typeof v === 'string'
const isNum = v => Number.isFinite(v)
const isStrArr = v => Array.isArray(v) && v.every(isStr)

function checkRequired(obj, fields, errors) {
  for (const [f, type] of Object.entries(fields)) {
    const v = obj?.[f]
    if (v === undefined || v === null) { errors.push(`missing field "${f}"`); continue }
    if (type === 'string' && !isStr(v)) errors.push(`field "${f}" must be a string`)
    if (type === 'number' && !isNum(v)) errors.push(`field "${f}" must be a number`)
    if (type === 'strarray' && !isStrArr(v)) errors.push(`field "${f}" must be an array of strings`)
  }
}

const SCHEMAS = {
  lead: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string' }, errors)
    if (!isStrArr(obj?.modules ?? [])) errors.push('modules must be an array of strings')
    if (!isStrArr(obj?.acceptance ?? [])) errors.push('acceptance must be an array of strings')
    if (obj?.ownership !== undefined && (typeof obj.ownership !== 'object' || obj.ownership === null)) errors.push('ownership must be an object')
    if (obj?.summary !== undefined && !isStr(obj.summary)) errors.push('summary must be a string')
    return errors
  },
  implementation: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string' }, errors)
    if (!isStrArr(obj?.changed_files ?? [])) errors.push('changed_files must be an array of strings')
    if (!isStrArr(obj?.commands ?? [])) errors.push('commands must be an array of strings')
    return errors
  },
  review: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string', verdict: 'string' }, errors)
    if (obj?.verdict && !['approve', 'changes_requested'].includes(obj.verdict)) {
      errors.push('verdict must be "approve" or "changes_requested"')
    }
    if (!Array.isArray(obj?.issues ?? [])) errors.push('issues must be an array')
    else {
      obj.issues.forEach((issue, i) => {
        if (!isStr(issue?.message)) errors.push(`issues[${i}].message must be a string`)
        if (issue?.severity !== undefined && !SEVERITIES.has(issue.severity)) errors.push(`issues[${i}].severity must be one of ${[...SEVERITIES].join(', ')}`)
        if (issue?.path !== undefined && !isStr(issue.path)) errors.push(`issues[${i}].path must be a string`)
        if (issue?.line !== undefined && issue.line !== null && !isNum(issue.line)) errors.push(`issues[${i}].line must be a number or null`)
      })
    }
    return errors
  },
  test_plan: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string' }, errors)
    if (!isStrArr(obj?.commands ?? [])) errors.push('commands must be an array of strings')
    return errors
  },
  patch: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string', base_revision: 'string' }, errors)
    if (!isStrArr(obj?.files ?? [])) errors.push('files must be an array of strings')
    if (!isStrArr(obj?.test_commands ?? [])) errors.push('test_commands must be an array of strings')
    if (obj?.patch_sha256 !== undefined && !isStr(obj.patch_sha256)) errors.push('patch_sha256 must be a string')
    return errors
  },
  integration: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string', base_revision: 'string' }, errors)
    if (!Array.isArray(obj?.decisions ?? [])) errors.push('decisions must be an array')
    else {
      obj.decisions.forEach((d, i) => {
        if (!isStr(d?.source ?? '')) errors.push(`decisions[${i}].source must be a string`)
        if (d?.adopted !== undefined && typeof d.adopted !== 'boolean') errors.push(`decisions[${i}].adopted must be a boolean`)
      })
    }
    if (!Array.isArray(obj?.conflicts ?? [])) errors.push('conflicts must be an array')
    if (!Array.isArray(obj?.stale_patches ?? [])) errors.push('stale_patches must be an array')
    if (!isStrArr(obj?.test_commands ?? [])) errors.push('test_commands must be an array of strings')
    return errors
  },
  verification: obj => {
    const errors = []
    checkRequired(obj, { node_id: 'string', agent_id: 'string', base_revision: 'string' }, errors)
    if (!isStrArr(obj?.commands ?? [])) errors.push('commands must be an array of strings')
    return errors
  },
}

// node kind -> schema key（kind 名与 schema 名不同：implement/test_review）
const KIND_TO_SCHEMA = {
  lead: 'lead',
  implement: 'implementation',
  review: 'review',
  test_review: 'test_plan',
  patch: 'patch',
  integrate: 'integration',
  verify: 'verification',
}

/** 校验某个 schema 对象；返回错误数组（空 = 通过）。 */
export function validateArtifactObject(kind, obj) {
  const fn = SCHEMAS[KIND_TO_SCHEMA[kind] ?? kind]
  if (!fn) return [`unknown artifact kind "${kind}"`]
  const errors = fn(obj)
  const id = obj?.node_id
  if (id !== undefined && typeof id !== 'string') errors.push('node_id must be a string')
  return errors
}

// ---------------------------------------------------------------- 目录级校验

/**
 * 校验 node 的 artifact 目录是否满足契约（含哈希一致性、路径越界、base SHA 一致性）。
 * 返回 {ok, errors, artifacts}；artifacts 为已解析的 JSON 对象映射（patch 含 diff 元数据）。
 */
export function validateNodeArtifacts({ kind, artifactDir, recordedBaseRevision = null, workspaceRoot = null }) {
  const errors = []
  const required = REQUIRED_ARTIFACTS[kind] ?? []
  const artifacts = {}
  for (const file of required) {
    const p = path.join(artifactDir, file)
    if (!fs.existsSync(p)) { errors.push(`missing required artifact "${file}"`); continue }
    if (file.endsWith('.diff')) {
      const stat = fs.statSync(p)
      if (stat.size === 0) errors.push('patch.diff is empty')
      artifacts[file] = { path: p, bytes: stat.size }
      continue
    }
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
      artifacts[file] = obj
      const errs = validateArtifactObject(kind, obj)
      errors.push(...errs.map(e => `${file}: ${e}`))
    } catch (error) {
      errors.push(`${file}: not valid JSON (${error.message})`)
    }
  }
  // base SHA 一致性：patch/integrate/verify 必须与记录一致
  if (recordedBaseRevision && (kind === 'patch' || kind === 'integrate' || kind === 'verify')) {
    const baseField = kind === 'patch' ? artifacts['patch.json']?.base_revision : kind === 'integrate' ? artifacts['integration.json']?.base_revision : artifacts['verification.json']?.base_revision
    if (baseField && baseField !== recordedBaseRevision) {
      errors.push(`base_revision mismatch: artifact says ${baseField}, recorded ${recordedBaseRevision}`)
    }
  }
  // patch 哈希一致性
  if (kind === 'patch' && artifacts['patch.json'] && artifacts['patch.diff']) {
    const declared = artifacts['patch.json'].patch_sha256
    const actual = sha256File(artifacts['patch.diff'].path)
    if (declared && declared !== actual) {
      errors.push(`patch_sha256 mismatch: declared ${declared}, actual ${actual}`)
    }
  }
  // 路径越界：artifact 中声明的任一文件路径不得逃出 workspaceRoot
  if (workspaceRoot) {
    const declaredPaths = []
    if (kind === 'patch' && Array.isArray(artifacts['patch.json']?.files)) declaredPaths.push(...artifacts['patch.json'].files)
    if (kind === 'review' && Array.isArray(artifacts['review.json']?.issues)) {
      for (const issue of artifacts['review.json'].issues) {
        if (typeof issue?.path === 'string') declaredPaths.push(issue.path)
      }
    }
    for (const p of declaredPaths) {
      try {
        assertPathInside(workspaceRoot, path.resolve(workspaceRoot, p))
      } catch (error) {
        errors.push(`path escapes workspace: ${p}`)
      }
    }
  }
  return { ok: errors.length === 0, errors, artifacts }
}

// ---------------------------------------------------------------- 下游摘要

/**
 * 下游 prompt 只拿依赖 artifact 的结构化摘要（Audit §5「不要将完整 finalText 串接到下游」）。
 * 包含：路径、base SHA、文件数、关键字段、测试命令；截断控制长度。
 */
export function summarizeNodeArtifacts({ nodeId, kind, artifactDir, maxChars = 2400, baseRevision = null }) {
  const parts = [`[node=${nodeId} kind=${kind}]`]
  if (baseRevision) parts.push(`base=${baseRevision}`)
  const required = REQUIRED_ARTIFACTS[kind] ?? []
  for (const file of required) {
    const p = path.join(artifactDir, file)
    if (!fs.existsSync(p)) { parts.push(`${file}: <missing>`); continue }
    if (file.endsWith('.diff')) {
      const bytes = fs.statSync(p).size
      parts.push(`${file}: ${bytes} bytes`)
      continue
    }
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
      parts.push(summarizeObject(file, obj))
    } catch {
      parts.push(`${file}: <unparsable>`)
    }
  }
  const text = parts.join('\n')
  return text.length > maxChars ? text.slice(0, maxChars) + '\n...[truncated]' : text
}

function summarizeObject(file, obj) {
  const lines = [`${file}:`]
  if (obj.node_id) lines.push(`  node_id=${obj.node_id}`)
  if (obj.agent_id) lines.push(`  agent_id=${obj.agent_id}`)
  if (obj.base_revision) lines.push(`  base_revision=${obj.base_revision}`)
  if (Array.isArray(obj.issues)) {
    const bySev = {}
    for (const i of obj.issues) bySev[i.severity ?? 'info'] = (bySev[i.severity ?? 'info'] ?? 0) + 1
    lines.push(`  issues=${obj.issues.length} by_severity=${JSON.stringify(bySev)}`)
    for (const i of obj.issues.slice(0, 5)) {
      lines.push(`    - [${i.severity ?? 'info'}] ${i.path ?? '(scope)'}${i.line != null ? ':' + i.line : ''} ${(i.message ?? '').slice(0, 160)}`)
    }
    if (obj.issues.length > 5) lines.push(`    ... (${obj.issues.length - 5} more)`)
  }
  if (Array.isArray(obj.files)) lines.push(`  files=${JSON.stringify(obj.files)}`)
  if (Array.isArray(obj.changed_files)) lines.push(`  changed_files=${JSON.stringify(obj.changed_files)}`)
  if (Array.isArray(obj.commands)) lines.push(`  commands=${JSON.stringify(obj.commands)}`)
  if (Array.isArray(obj.test_commands)) lines.push(`  test_commands=${JSON.stringify(obj.test_commands)}`)
  if (Array.isArray(obj.decisions)) {
    lines.push(`  decisions=${obj.decisions.length}`)
    for (const d of obj.decisions.slice(0, 8)) {
      lines.push(`    - ${d.source}: ${d.adopted ? 'adopt' : 'reject'}${d.reason ? ' — ' + d.reason.slice(0, 120) : ''}`)
    }
  }
  if (Array.isArray(obj.conflicts) && obj.conflicts.length) {
    lines.push(`  conflicts=${obj.conflicts.length}`)
    for (const c of obj.conflicts.slice(0, 8)) lines.push(`    - ${c.nodeId ?? c.source ?? '?'}: ${c.reason ?? ''}`)
  }
  if (Array.isArray(obj.stale_patches) && obj.stale_patches.length) {
    lines.push(`  stale_patches=${obj.stale_patches.length}`)
    for (const s of obj.stale_patches.slice(0, 8)) lines.push(`    - ${s.nodeId ?? s.source ?? '?'}: ${s.reason ?? ''}`)
  }
  if (Array.isArray(obj.test_exit_codes)) lines.push(`  test_exit_codes=${JSON.stringify(obj.test_exit_codes)}`)
  if (obj.commit) lines.push(`  commit=${obj.commit}`)
  if (obj.evidence) lines.push(`  evidence=${String(obj.evidence).slice(0, 200)}`)
  if (obj.summary) lines.push(`  summary=${String(obj.summary).slice(0, 200)}`)
  return lines.join('\n')
}

/** 从 agent transcript 的 Bash 工具调用中提取命令列表（implementation.json 证据）。 */
export function extractCommandsFromTranscript(transcript, { limit = 20 } = {}) {
  const out = []
  for (const entry of transcript ?? []) {
    if (entry?.type === 'tool_result' && entry?.name === 'Bash' && typeof entry?.input?.command === 'string') {
      out.push(entry.input.command)
      if (out.length >= limit) break
    }
  }
  return out
}