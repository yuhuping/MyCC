// multiagent/lib/worktree.mjs
// 工作区 / 版本 / patch 的 git 命令集中层（Audit §5）。
// 所有 git 命令都收敛在这里，便于 fake 测试与审计：
//   - initGitRepo / commitAll / headSha：main 工作区版本管理
//   - worktreeAdd / worktreeRemove / listWorktrees：隔离 worktree 生命周期
//   - collectPatch / applyPatchCheck / applyPatch：patch 采集与确定性应用
//   - gitDiffQuiet / gitStatusPorcelain：read_only 违规检测
//   - runTestCommand：带超时/信号/截断输出的测试命令执行（§7 验证门禁）
//
// 注意：全部使用异步 spawn（Node 的 spawnSync 单次调用 ~100ms，会拖垮并行编排）。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

export class GitError extends Error {
  constructor(message, { args = [], cwd = '', code = null, stderr = '' } = {}) {
    super(message)
    this.name = 'GitError'
    this.args = args
    this.cwd = cwd
    this.code = code
    this.stderr = stderr
  }
}

const MAX_CAPTURE = 64 * 1024 * 1024

function runGit(dir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let outTruncated = false
    let errTruncated = false
    child.stdout.on('data', d => {
      if (out.length < MAX_CAPTURE) out += d
      else outTruncated = true
    })
    child.stderr.on('data', d => {
      if (err.length < MAX_CAPTURE) err += d
      else errTruncated = true
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new GitError(`git ${args.join(' ')} failed (exit ${code})`, {
          args, cwd: dir, code, stderr: (err + (errTruncated ? '\n[stderr truncated]' : '')).slice(0, 4000),
        }))
        return
      }
      resolve(out + (outTruncated ? '\n[stdout truncated]' : ''))
    })
  })
}

async function isGitRepo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return false
  try {
    const out = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

export { isGitRepo }

/** 初始化 git 仓库 + 空初始 commit（保证 HEAD 存在，diff/base SHA 可计算）。
 * 幂等：已是完整 git 仓库则直接返回 HEAD；残缺 .git（半初始化）先清掉再重建。 */
export async function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const gitDir = path.join(dir, '.git')
  if (fs.existsSync(gitDir)) {
    try {
      await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
      const sha = await headSha(dir)
      if (sha) return sha // 完整仓库
    } catch { /* 残缺 .git，重建 */ }
    fs.rmSync(gitDir, { recursive: true, force: true })
  }
  await runGit(dir, ['init', '-q'])
  // 忽略编译产物，防止 worker patch / main commit 混入二进制残留（__pycache__/*.pyc 会让 git apply 失败）
  const gi = path.join(dir, '.gitignore')
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, '__pycache__/\n*.py[cod]\n.DS_Store\n')
  }
  await runGit(dir, ['checkout', '-q', '-b', 'main'])
  await runGit(dir, ['-c', 'user.email=mycc@local', '-c', 'user.name=mycc', 'add', '-A'])
  // --allow-empty：保证空工作区也有初始 commit，HEAD 恒存在
  await runGit(dir, ['-c', 'user.email=mycc@local', '-c', 'user.name=mycc', 'commit', '-q', '--allow-empty', '-m', 'init'])
  return headSha(dir)
}

/** 当前 HEAD SHA；仓库无 HEAD 时返回 null（单次 spawn，避免 isGitRepo 二次调用）。 */
export async function headSha(dir) {
  try {
    return (await runGit(dir, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

/** add -A 并 commit；无可提交内容时返回 {sha, committed:false}。 */
export async function commitAll(dir, message) {
  await runGit(dir, ['add', '-A'])
  try {
    await runGit(dir, ['-c', 'user.email=mycc@local', '-c', 'user.name=mycc', 'commit', '-q', '-m', message])
  } catch (error) {
    return { sha: await headSha(dir), committed: false, output: error.message.slice(0, 500) }
  }
  return { sha: await headSha(dir), committed: true }
}

/** 在 main 仓库下创建隔离 worktree（detached at baseRevision）。返回 {path, baseRevision}。 */
export async function worktreeAdd({ mainRepo, worktreePath, baseRevision }) {
  if (!baseRevision) throw new GitError('worktreeAdd requires a baseRevision')
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  if (fs.existsSync(worktreePath)) {
    fs.rmSync(worktreePath, { recursive: true, force: true })
  }
  await runGit(mainRepo, ['worktree', 'add', '--detach', worktreePath, baseRevision])
  const actual = await headSha(worktreePath)
  if (actual !== baseRevision) {
    throw new GitError(`worktree HEAD ${actual} != baseRevision ${baseRevision}`, { cwd: worktreePath })
  }
  return { path: worktreePath, baseRevision: actual }
}

/** 移除隔离 worktree；失败时返回 {ok:false, reason}（绝不静默删除调试证据）。 */
export async function worktreeRemove({ mainRepo, worktreePath }) {
  try {
    await runGit(mainRepo, ['worktree', 'remove', '--force', worktreePath])
    return { ok: true }
  } catch (error) {
    try {
      await runGit(mainRepo, ['worktree', 'prune', '-n'])
    } catch { /* ignore */ }
    return { ok: false, reason: error.message.slice(0, 500) }
  }
}

/** 列出 main 仓库当前注册的全部 worktree 路径（测试断言无残留）。 */
export async function listWorktrees(mainRepo) {
  const out = await runGit(mainRepo, ['worktree', 'list', '--porcelain'])
  const paths = []
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim())
  }
  return paths
}

/** worktree 内相对 baseRevision 的全部改动（已提交 + 未提交），输出 unified diff 文本。 */
export async function collectPatch({ dir, baseRevision }) {
  const diff = await runGit(dir, ['diff', baseRevision])
  return { diff, sha256: crypto.createHash('sha256').update(diff, 'utf8').digest('hex') }
}

/** 相对 base 改动的文件列表（工作区 + 已提交）。 */
export async function diffNameOnly({ dir, baseRevision }) {
  const out = (await runGit(dir, ['diff', '--name-only', baseRevision])).trim()
  return out ? out.split('\n').filter(Boolean) : []
}

/** git apply --check：返回 {status:'clean'} | {status:'fails', detail}。 */
export async function applyPatchCheck({ dir, patchPath }) {
  try {
    await runGit(dir, ['apply', '--check', patchPath])
    return { status: 'clean' }
  } catch (error) {
    return { status: 'fails', detail: error.message.slice(0, 1000) }
  }
}

/** 确定性应用 patch；base 不匹配 => stale_patch，check 失败 => apply_failed。 */
export async function applyPatch({ dir, patchPath, baseRevision, expectedBaseRevision }) {
  if (expectedBaseRevision && baseRevision !== expectedBaseRevision) {
    return { ok: false, reason: 'stale_patch', detail: `patch base ${baseRevision} != expected ${expectedBaseRevision}` }
  }
  const check = await applyPatchCheck({ dir, patchPath })
  if (check.status !== 'clean') {
    return { ok: false, reason: 'apply_failed', detail: check.detail }
  }
  try {
    await runGit(dir, ['apply', patchPath])
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: 'apply_failed', detail: error.message.slice(0, 1000) }
  }
}

/** 回滚 main 工作区到 HEAD（集成冲突/失败时保证 main 可复现，不采用 last-writer-wins）。 */
export async function hardResetToHead(dir) {
  await runGit(dir, ['reset', '--hard', 'HEAD'])
  await runGit(dir, ['clean', '-fdq'])
}

/** tracked（含 staged）是否有改动：read_only 违规检测用。忽略 untracked。 */
export async function gitDiffQuiet(dir) {
  try {
    await runGit(dir, ['diff', '--quiet'])
    await runGit(dir, ['diff', '--cached', '--quiet'])
    return true
  } catch {
    return false
  }
}

export async function gitStatusPorcelain(dir) {
  return (await runGit(dir, ['status', '--porcelain'])).split('\n').filter(Boolean)
}

/** 轻量语法检查：.py -> python -m py_compile，.js/.mjs -> node --check。失败返回 {ok:false, detail}。 */
export async function lightSyntaxCheck(dir, files) {
  const byExt = { '.py': [], '.js': [], '.mjs': [], '.cjs': [] }
  for (const f of files) {
    const ext = path.extname(f)
    if (ext in byExt) byExt[ext].push(path.join(dir, f))
  }
  const results = []
  for (const [ext, list] of Object.entries(byExt)) {
    if (!list.length) continue
    if (ext === '.py') {
      const ok = await checkCommand('python3', ['-m', 'py_compile', ...list], dir)
      if (!ok.ok) results.push({ file: list[0], ok: false, detail: ok.detail })
    } else {
      for (const f of list) {
        const ok = await checkCommand('node', ['--check', f], dir)
        if (!ok.ok) results.push({ file: f, ok: false, detail: ok.detail })
      }
    }
  }
  return results
}

function checkCommand(cmd, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { if (err.length < 8000) err += d })
    child.on('error', () => resolve({ ok: false, detail: `${cmd} not available` }))
    child.on('close', code => resolve(code === 0 ? { ok: true } : { ok: false, detail: err.slice(0, 800) }))
  })
}

/**
 * 执行验证/测试命令（§7 验证门禁）：shell 执行、超时、AbortSignal、截断输出。
 * 返回 {command, exit_code, timed_out, aborted, stdout_bytes, stderr_bytes, ...}。
 * 约定：timeout 时 exit_code = 124（同 timeout(1) 语义）。
 */
const MAX_CAPTURE_BYTES = 64 * 1024

export function runTestCommand({ dir, command, timeoutMs = 60_000, signal = null }) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(command, { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    let finished = false
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs) : null

    const onAbort = () => { child.kill('SIGKILL') }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', d => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += d })
    child.stderr.on('data', d => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += d })
    child.on('error', err => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      resolve({ command, exit_code: -1, timed_out, aborted: !!signal?.aborted, error: err.message, stdout_bytes: Buffer.byteLength(stdout), stderr_bytes: Buffer.byteLength(stderr), stdout_head: stdout.slice(0, 2000), stderr_head: stderr.slice(0, 2000) })
    })
    child.on('close', code => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        command,
        exit_code: timedOut ? 124 : (code ?? -1),
        timed_out: timedOut,
        aborted: !!signal?.aborted,
        stdout_bytes: Buffer.byteLength(stdout),
        stderr_bytes: Buffer.byteLength(stderr),
        stdout_head: stdout.slice(0, 2000),
        stderr_head: stderr.slice(0, 2000),
      })
    })
  })
}