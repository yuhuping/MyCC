import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

class GitCommandError extends Error {
  constructor(message, { cwd, args, stderr = '' } = {}) {
    super(message)
    this.name = 'GitCommandError'
    this.cwd = cwd
    this.args = args
    this.stderr = stderr
  }
}

function git(cwd, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0 && !allowFailure) {
        reject(new GitCommandError(`git ${args.join(' ')} failed (exit ${code})`, { cwd, args, stderr }))
      } else resolve({ code, stdout, stderr })
    })
  })
}

async function head(cwd) {
  const result = await git(cwd, ['rev-parse', 'HEAD'], { allowFailure: true })
  return result.code === 0 ? result.stdout.trim() : null
}

async function copyEntry(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true, force: true, dereference: false })
}

/**
 * Create a detached worktree whose initial commit represents the caller's
 * complete dirty snapshot.  The lead index and branch are never touched.
 */
export async function createTeamWorktree({ workspace, worktreePath }) {
  const root = path.resolve(workspace)
  const target = path.resolve(worktreePath)
  const base = await head(root)
  if (!base) throw new Error(`Team worktrees require a git repository with HEAD: ${root}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await git(root, ['worktree', 'add', '--detach', target, base])
  try {
    const diff = await git(root, ['diff', '--no-ext-diff', '--binary', 'HEAD'])
    if (diff.stdout) {
      const patchPath = path.join(path.dirname(target), `.initial-${crypto.randomUUID()}.patch`)
      await fs.writeFile(patchPath, diff.stdout)
      try { await git(target, ['apply', '--binary', patchPath]) } finally { await fs.rm(patchPath, { force: true }) }
    }
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    for (const relative of untracked.stdout.split('\0').filter(Boolean)) {
      // Worktree metadata is intentionally ignored and never copied.
      if (relative === '.mycc' || relative.startsWith('.mycc/')) continue
      await copyEntry(path.join(root, relative), path.join(target, relative))
    }
    await git(target, ['add', '-A'])
    const checkpoint = await git(target, ['-c', 'user.email=mycc@local', '-c', 'user.name=mycc', 'commit', '--quiet', '--allow-empty', '-m', 'mycc team checkpoint'], { allowFailure: true })
    if (checkpoint.code !== 0) throw new GitCommandError('Could not create team checkpoint', { cwd: target, args: ['commit'], stderr: checkpoint.stderr })
    const checkpointRevision = await head(target)
    return { path: target, baseRevision: checkpointRevision }
  } catch (error) {
    await removeTeamWorktree({ workspace: root, worktreePath: target })
    throw error
  }
}

export async function removeTeamWorktree({ workspace, worktreePath }) {
  const result = await git(path.resolve(workspace), ['worktree', 'remove', '--force', path.resolve(worktreePath)], { allowFailure: true })
  if (result.code !== 0) return { ok: false, reason: result.stderr.trim() || 'git worktree remove failed' }
  return { ok: true }
}

/** Capture tracked, deleted, and untracked content as a binary-safe patch. */
export async function captureTeamPatch({ worktreePath, baseRevision, patchPath }) {
  // A failed/aborted previous capture may have left the teammate index
  // staged. Rebuild it from the checkpoint while preserving worktree bytes.
  await git(worktreePath, ['reset', '--mixed', '--quiet'])
  await git(worktreePath, ['add', '-A'])
  const result = await git(worktreePath, ['diff', '--cached', '--no-ext-diff', '--binary', baseRevision])
  const diff = result.stdout
  await fs.mkdir(path.dirname(patchPath), { recursive: true })
  await fs.writeFile(patchPath, diff)
  return { patchPath, bytes: Buffer.byteLength(diff), sha256: crypto.createHash('sha256').update(diff).digest('hex') }
}

export async function checkpointTeamWorktree({ worktreePath, message = 'mycc team checkpoint' }) {
  const staged = await git(worktreePath, ['diff', '--cached', '--quiet'], { allowFailure: true })
  if (staged.code === 0) return await head(worktreePath)
  await git(worktreePath, ['-c', 'user.email=mycc@local', '-c', 'user.name=mycc', 'commit', '--quiet', '-m', message])
  return await head(worktreePath)
}

export async function applyTeamPatch({ workspace, patchPath }) {
  const root = path.resolve(workspace)
  const check = await git(root, ['apply', '--check', '--binary', patchPath], { allowFailure: true })
  if (check.code !== 0) return { ok: false, reason: 'apply_failed', detail: check.stderr.trim() }
  const applied = await git(root, ['apply', '--binary', patchPath], { allowFailure: true })
  if (applied.code !== 0) return { ok: false, reason: 'apply_failed', detail: applied.stderr.trim() }
  return { ok: true }
}

export async function gitStatus(workspace) {
  const result = await git(path.resolve(workspace), ['status', '--porcelain'])
  return result.stdout.split('\n').filter(Boolean)
}
