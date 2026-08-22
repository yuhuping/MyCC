import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { canUseTool, globToRegExp } from './permissions.mjs'

const DEFAULT_MAX_CHARS = 50_000
const READ_DEFAULT_LIMIT = 2_000
// 源码 Glob/Grep 默认包含隐藏文件(glob.ts:98-119 的 --hidden);这里只排除
// 明确的依赖/构建目录与 VCS 元数据,不再跳过 . 开头的配置与规则文件
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.svn', '.hg', '.jj', '.sl'])
// 大工具结果落盘目录(与 agent.mjs 一致):Read 工具可回读该 workspace 外路径
const TOOL_RESULTS_DIR = path.join(os.tmpdir(), 'mycc-tool-results')
// Glob 默认结果上限(GlobTool.ts:157 globLimits.maxResults ?? 100)
const GLOB_DEFAULT_MAX_RESULTS = 100
// Grep 默认 head_limit(GrepTool.ts:108 DEFAULT_HEAD_LIMIT)
const GREP_DEFAULT_HEAD_LIMIT = 250
const POST_COMPACT_MAX_FILES = 5
const POST_COMPACT_MAX_CHARS_PER_FILE = 20_000
const POST_COMPACT_MAX_CHARS = 200_000

// read-before-write 状态(FileEditTool.ts / FileWriteTool.ts readFileState 语义):key 为绝对路径
const readFileState = new Map()

// 统一工具协议为 CC 核心集合(getAllBaseTools 的子集,src/tools.ts:193):
// Read/Write/Edit/Glob/Grep/Bash/Agent,字段名与返回形状对齐 FileRead/FileWrite/
// FileEdit/Glob/Grep/Bash/Agent 工具
export const TOOL_DEFINITIONS = [
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem. The result uses cat -n style line numbers. By default it returns up to 2000 lines; for long files, continue with offset and limit. Do not copy the line-number prefix into Edit old_string or new_string.',
    isReadOnly: true,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to read (relative to the workspace).' },
        offset: { type: 'integer', minimum: 0, description: '1-based line number to start reading from.' },
        limit: { type: 'integer', minimum: 1, description: 'Number of lines to read.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'Write',
    description: 'Create a new file or overwrite an existing one inside the workspace. Existing files must be read first.',
    isReadOnly: false,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to write (relative to the workspace).' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'Edit',
    description: 'Replace an exact substring in a file inside the workspace. The file must be read first, old_string must match exactly and uniquely unless replace_all is true, and Read line-number prefixes must not be included.',
    isReadOnly: false,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the file to modify (relative to the workspace).' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring a unique match.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern under the workspace. ** crosses directories, * matches within one, ? matches one char.',
    isReadOnly: true,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.py or src/**' },
        path: { type: 'string', description: 'Optional relative base directory to search in.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'Grep',
    description: 'Search a regular expression in workspace text files. Supports content / files_with_matches / count output modes with line numbers, context lines, case-insensitivity, glob/type filters and pagination.',
    isReadOnly: true,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Optional relative directory or file to search in.' },
        glob: { type: 'string', description: 'Glob pattern to filter files, e.g. "*.js" or "*.{ts,tsx}" (maps to rg --glob).' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: '"content" shows matching lines with context and line numbers; "files_with_matches" shows file paths (default); "count" shows match counts per file.' },
        '-A': { type: 'integer', minimum: 0, description: 'Number of lines to show after each match (content mode only).' },
        '-B': { type: 'integer', minimum: 0, description: 'Number of lines to show before each match (content mode only).' },
        '-C': { type: 'integer', minimum: 0, description: 'Number of lines to show before and after each match (content mode only).' },
        context: { type: 'integer', minimum: 0, description: 'Alias for -C: lines before and after each match (content mode only).' },
        '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true).' },
        '-i': { type: 'boolean', description: 'Case insensitive search.' },
        type: { type: 'string', description: 'File type to search by extension, e.g. "py", "js", "ts", "go".' },
        head_limit: { type: 'integer', minimum: 0, description: 'Maximum number of lines/entries to return (0 = unlimited, default 250).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip the first N lines/entries before applying head_limit (default 0).' },
        multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command in the workspace and return combined output. The command runs with the workspace as cwd.',
    isReadOnly: false,
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1, maximum: 600_000, description: 'Timeout in milliseconds.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'Agent',
    description: 'Delegate a sub-task to a nested coding agent and return its final answer. Use for isolated subtasks that can be verified independently.',
    isReadOnly: false,
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        cwd: { type: 'string', description: 'Optional sub-workspace relative to the current workspace.' },
        max_turns: { type: 'integer', minimum: 1, maximum: 50 },
        model: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
]

function validateInput(schema, input) {
  if (!schema) return
  const properties = schema.properties ?? {}
  for (const req of schema.required ?? []) {
    if (!(req in input)) throw new Error(`Missing required input: ${req}`)
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in properties)) throw new Error(`Unknown input: ${key}`)
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = properties[key]
    if (!prop || value === undefined || value === null) continue
    if (prop.type === 'string' && typeof value !== 'string') throw new Error(`Input ${key} must be a string`)
    if (prop.type === 'integer' && !Number.isInteger(value)) throw new Error(`Input ${key} must be an integer`)
    if (prop.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Input ${key} must be a boolean`)
    if (prop.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`Input ${key} must be an object`)
    if (prop.minimum !== undefined && typeof value === 'number' && value < prop.minimum) throw new Error(`Input ${key} must be >= ${prop.minimum}`)
  }
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${candidate}`)
  }
}

export function resolveWorkspacePath(workspace, requested = '.') {
  const root = path.resolve(workspace)
  const candidate = path.resolve(root, requested)
  assertInside(root, candidate)
  return candidate
}

function translateDisplayPath(workspace, requested, displayWorkspace) {
  if (!displayWorkspace || typeof requested !== 'string' || !path.isAbsolute(requested)) return requested
  const relative = path.relative(path.resolve(displayWorkspace), path.resolve(requested))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return requested
  return path.join(path.resolve(workspace), relative)
}

async function walkFiles(root, current, output, limit = Infinity) {
  if (output.length >= limit) return
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) await walkFiles(root, full, output, limit)
    else if (entry.isFile()) output.push(path.relative(root, full))
    if (output.length >= limit) return
  }
}

// Read 工具路径解析:优先 workspace 内;工具结果落盘目录(workspace 外)放行回读
function resolveReadTarget(workspace, requestedPath) {
  try {
    return resolveWorkspacePath(workspace, requestedPath)
  } catch (error) {
    const candidate = path.resolve(requestedPath)
    const rel = path.relative(TOOL_RESULTS_DIR, candidate)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return candidate
    throw error
  }
}

async function readTextFile(workspace, filePath, offset, limit) {
  const target = resolveReadTarget(workspace, filePath)
  const content = await fs.readFile(target, 'utf8')
  const lines = content.split(/\r?\n/)
  const start = Math.max(1, offset ?? 1)
  const requestedLimit = limit ?? READ_DEFAULT_LIMIT
  const requestedEnd = Math.min(lines.length, start + requestedLimit - 1)
  const selected = lines.slice(start - 1, requestedEnd)
  const formattedLines = []
  let formattedChars = 0
  for (let index = 0; index < selected.length; index++) {
    const formatted = `${String(index + start).padStart(6, ' ')}→${selected[index]}`
    const extra = formattedLines.length === 0 ? formatted.length : formatted.length + 1
    if (formattedChars + extra > DEFAULT_MAX_CHARS) break
    formattedLines.push(formatted)
    formattedChars += extra
  }
  const end = formattedLines.length > 0 ? start + formattedLines.length - 1 : start - 1
  const truncated = end < requestedEnd || requestedEnd < lines.length
  const nextOffset = truncated ? end + 1 : undefined
  // 记录 read state(原始文本,不带行号)供 Edit/Write 的 read-before-write 校验
  const isFullRead = start === 1 && end === lines.length
  readFileState.set(target, { content, timestamp: Date.now(), isFullRead })
  return {
    file_path: path.relative(path.resolve(workspace), target),
    start_line: start,
    end_line: end,
    num_lines: formattedLines.length,
    total_lines: lines.length,
    content: formattedLines.join('\n'),
    truncated,
    ...(nextOffset !== undefined && { next_offset: nextOffset }),
  }
}

async function globFiles(workspace, pattern, requestedPath = '.', maxResults = GLOB_DEFAULT_MAX_RESULTS) {
  const root = path.resolve(workspace)
  const target = resolveWorkspacePath(workspace, requestedPath)
  const files = []
  await walkFiles(root, target, files)
  const regex = globToRegExp(pattern)
  const filenames = []
  for (const relative of files) {
    const candidate = relative.replaceAll('\\', '/')
    if (regex.test(candidate)) {
      filenames.push(candidate)
      if (filenames.length > maxResults) break
    }
  }
  const truncated = filenames.length > maxResults
  if (truncated) filenames.length = maxResults
  return { filenames, numFiles: filenames.length, truncated }
}

// rg --type 常见扩展名子集(源码走 ripgrep 内置类型表)
const GREP_TYPE_EXTENSIONS = {
  js: /\.(js|mjs|cjs|jsx)$/i,
  jsx: /\.jsx$/i,
  ts: /\.(ts|mts|cts|tsx)$/i,
  tsx: /\.tsx$/i,
  py: /\.py$/i,
  pyi: /\.pyi$/i,
  go: /\.go$/i,
  rs: /\.rs$/i,
  java: /\.java$/i,
  c: /\.(c|h)$/i,
  cpp: /\.(cpp|cc|cxx|hpp|hh|hxx)$/i,
  rb: /\.rb$/i,
  php: /\.php$/i,
  sql: /\.sql$/i,
  html: /\.(html|htm)$/i,
  css: /\.css$/i,
  md: /\.(md|markdown)$/i,
  json: /\.json$/i,
  yaml: /\.(yaml|yml)$/i,
  toml: /\.toml$/i,
  sh: /\.(sh|bash|zsh)$/i,
  txt: /\.txt$/i,
}

// 拆 glob 参数:逗号/空白分隔,但保留 {a,b} brace 整体(rg --glob 语义)
function splitGlobPatterns(glob) {
  const patterns = []
  for (const raw of glob.split(/\s+/).filter(Boolean)) {
    if (raw.includes('{') && raw.includes('}')) patterns.push(raw)
    else patterns.push(...raw.split(',').filter(Boolean))
  }
  return patterns
}

// 行号相关辅助:match.index 前的换行数 = 0-based 起始行
function countNewlines(text, end) {
  let count = 0
  for (let i = 0; i < end; i++) if (text[i] === '\n') count++
  return count
}

// head_limit/offset 分页:源码 applyHeadLimit 语义(0 = unlimited,截断才报 appliedLimit)
function applyPagination(items, limit, offset) {
  if (limit === 0) return { items: items.slice(offset), appliedLimit: undefined }
  const effective = limit ?? GREP_DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effective)
  const wasTruncated = items.length - offset > effective
  return { items: sliced, appliedLimit: wasTruncated ? effective : undefined }
}

async function grepText(workspace, input = {}) {
  const {
    pattern,
    path: requestedPath,
    glob,
    output_mode: outputMode = 'files_with_matches',
    '-A': after = 0,
    '-B': before = 0,
    '-C': contextBoth = 0,
    context = 0,
    '-n': lineNumbers = true,
    '-i': caseInsensitive = false,
    type: fileType,
    head_limit: headLimit,
    offset = 0,
    multiline = false,
  } = input
  const root = path.resolve(workspace)
  const target = requestedPath ? resolveWorkspacePath(workspace, requestedPath) : root
  let files = []
  const stat = await fs.stat(target)
  if (stat.isFile()) {
    files.push(path.relative(root, target))
  } else {
    await walkFiles(root, target, files)
  }
  if (glob) {
    const patterns = splitGlobPatterns(glob).map(globToRegExp)
    files = files.filter(rel => patterns.some(re => re.test(rel.replaceAll('\\', '/'))))
  }
  if (fileType) {
    const typeRe = GREP_TYPE_EXTENSIONS[String(fileType).toLowerCase()]
    if (typeRe) files = files.filter(rel => typeRe.test(rel))
  }
  let re
  try {
    // g flag:multiline 用 exec 循环推进 lastIndex;逐行模式每次重置 lastIndex=0,无影响
    re = new RegExp(pattern, `${caseInsensitive ? 'i' : ''}${multiline ? 's' : ''}g`)
  } catch (error) {
    throw new Error(`Invalid regex: ${error.message}`)
  }
  const ctxBefore = Math.max(before, contextBoth, context)
  const ctxAfter = Math.max(after, contextBoth, context)
  const fileMatches = []
  const countEntries = [] // { rel, count }
  const contentLines = [] // rg 风格输出行(相对路径 + 行号 + 内容)
  for (const rel of files) {
    let content
    try {
      content = await fs.readFile(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    const hitLines = []
    if (multiline) {
      re.lastIndex = 0
      let match
      while ((match = re.exec(content)) !== null) {
        if (match.index === re.lastIndex) re.lastIndex++ // 零宽匹配防死循环
        const start = countNewlines(content, match.index)
        const span = (match[0].match(/\n/g)?.length ?? 0)
        for (let line = start; line <= start + span; line++) hitLines.push(line)
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0
        if (re.test(lines[i])) hitLines.push(i)
      }
    }
    if (!hitLines.length) continue
    if (outputMode === 'files_with_matches') {
      fileMatches.push(rel)
      continue
    }
    if (outputMode === 'count') {
      countEntries.push({ rel, count: hitLines.length })
      continue
    }
    // content:命中行分组为连续块(块间以 "--" 分隔,对应 rg -A/-B/-C 输出),
    // 块内包含上下文行;匹配行用 ":"、上下文行用 "-" 分隔符
    const groups = []
    let group = null
    for (const hit of [...new Set(hitLines)].sort((a, b) => a - b)) {
      const start = Math.max(0, hit - ctxBefore)
      const end = Math.min(lines.length - 1, hit + ctxAfter)
      if (group && start <= group.end + 1) {
        group.end = Math.max(group.end, end)
      } else {
        if (group) groups.push(group)
        group = { start, end }
      }
    }
    if (group) groups.push(group)
    for (let g = 0; g < groups.length; g++) {
      if (g > 0) contentLines.push('--')
      for (let line = groups[g].start; line <= groups[g].end; line++) {
        const isMatch = hitLines.includes(line)
        if (lineNumbers) contentLines.push(`${rel}:${line + 1}${isMatch ? ':' : '-'}${lines[line]}`)
        else contentLines.push(`${rel}${isMatch ? ':' : '-'}${lines[line]}`)
      }
    }
  }
  const appliedOffset = offset > 0 ? offset : undefined
  if (outputMode === 'content') {
    const { items, appliedLimit } = applyPagination(contentLines, headLimit, offset)
    return {
      mode: 'content', numFiles: 0, filenames: [],
      content: items.join('\n'), numLines: items.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(appliedOffset !== undefined && { appliedOffset }),
    }
  }
  if (outputMode === 'count') {
    const { items, appliedLimit } = applyPagination(countEntries, headLimit, offset)
    const numMatches = items.reduce((sum, entry) => sum + entry.count, 0)
    return {
      mode: 'count', numFiles: items.length, filenames: [],
      content: items.map(entry => `${entry.rel}:${entry.count}`).join('\n'), numMatches,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(appliedOffset !== undefined && { appliedOffset }),
    }
  }
  const { items, appliedLimit } = applyPagination(fileMatches, headLimit, offset)
  return {
    mode: 'files_with_matches', filenames: items, numFiles: items.length,
    ...(appliedLimit !== undefined && { appliedLimit }),
    ...(appliedOffset !== undefined && { appliedOffset }),
  }
}

function grepPagination(result) {
  const parts = []
  if (result.appliedLimit !== undefined) parts.push(`limit: ${result.appliedLimit}`)
  if (result.appliedOffset !== undefined) parts.push(`offset: ${result.appliedOffset}`)
  return parts.join(', ')
}

/** Convert internal tool data to the compact model-facing text used in tool_result. */
export function formatToolResultForModel(name, result) {
  if (result?.error) return `Error: ${result.error}`
  switch (name) {
    case 'Read': {
      if (!result.content) {
        if (result.total_lines === 0) return '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
        return `<system-reminder>Warning: the file is shorter than the provided offset (${result.start_line}). The file has ${result.total_lines} lines.</system-reminder>`
      }
      if (!result.truncated) return result.content
      return `${result.content}\n\n<system-reminder>File has ${result.total_lines} lines. Continue reading with offset=${result.next_offset}.</system-reminder>`
    }
    case 'Glob':
      if (result.filenames.length === 0) return 'No files found'
      return [
        ...result.filenames,
        ...(result.truncated ? ['(Results are truncated. Consider using a more specific path or pattern.)'] : []),
      ].join('\n')
    case 'Grep': {
      const pagination = grepPagination(result)
      if (result.mode === 'content') {
        const body = result.content || 'No matches found'
        return pagination ? `${body}\n\n[Showing results with pagination = ${pagination}]` : body
      }
      if (result.mode === 'count') {
        const matches = result.numMatches ?? 0
        const files = result.numFiles ?? 0
        const body = result.content || 'No matches found'
        return `${body}\n\nFound ${matches} total ${matches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${pagination ? ` with pagination = ${pagination}` : ''}`
      }
      if (result.numFiles === 0) return 'No files found'
      return `Found ${result.numFiles} ${result.numFiles === 1 ? 'file' : 'files'}${pagination ? ` ${pagination}` : ''}\n${result.filenames.join('\n')}`
    }
    case 'Write':
      return result.created
        ? `File created successfully at: ${result.file_path}`
        : `The file ${result.file_path} has been updated successfully.`
    case 'Edit':
      return result.replaced > 1
        ? `The file ${result.file_path} has been updated. All occurrences were successfully replaced.`
        : `The file ${result.file_path} has been updated successfully.`
    case 'Bash': {
      const stdout = String(result.stdout ?? '').replace(/^(\s*\n)+/, '').trimEnd()
      const stderr = String(result.stderr ?? '').trim()
      const output = [stdout, stderr].filter(Boolean).join('\n')
      if (result.aborted) return `${output}${output ? '\n' : ''}<error>Command was aborted before completion</error>`
      if (result.timed_out) return `${output}${output ? '\n' : ''}<error>Command timed out</error>`
      return output || `Command completed with exit code ${result.exit_code}.`
    }
    case 'Agent':
      return String(result.result ?? '')
    default:
      return JSON.stringify(result)
  }
}

function truncateAtLineBoundary(text, maxChars) {
  if (text.length <= maxChars) return text
  const end = text.lastIndexOf('\n', maxChars)
  return end > 0 ? text.slice(0, end) : ''
}

/** Re-read recent files after full compact, bounded like Claude Code's post-compact attachments. */
export async function createPostCompactFileAttachments(workspace, { excludeFiles = new Set(), maxFiles = POST_COMPACT_MAX_FILES } = {}) {
  const root = path.resolve(workspace)
  const recent = [...readFileState.entries()]
    .filter(([filename]) => {
      const relative = path.relative(root, filename)
      return !relative.startsWith('..') && !path.isAbsolute(relative) && !excludeFiles.has(relative.replaceAll('\\', '/'))
    })
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .slice(0, maxFiles)
  const attachments = []
  let totalChars = 0
  for (const [filename] of recent) {
    const relative = path.relative(root, filename).replaceAll('\\', '/')
    let result
    try {
      result = await readTextFile(workspace, relative, 1, READ_DEFAULT_LIMIT)
    } catch {
      continue
    }
    const content = truncateAtLineBoundary(formatToolResultForModel('Read', result), POST_COMPACT_MAX_CHARS_PER_FILE)
    if (!content || totalChars + content.length > POST_COMPACT_MAX_CHARS) continue
    totalChars += content.length
    attachments.push({
      file_path: relative,
      content: `<system-reminder>\nThe following file was read before compaction and is included again for continuity: ${relative}\n\n${content}\n</system-reminder>`,
    })
  }
  return attachments
}

async function writeFileTool(workspace, filePath, content) {
  const target = resolveWorkspacePath(workspace, filePath)
  let exists = true
  try {
    await fs.access(target)
  } catch {
    exists = false
  }
  if (exists) {
    // read-before-write(FileWriteTool.ts:198-219 语义):覆盖已存在文件前必须 Read
    const lastRead = readFileState.get(target)
    const stat = await fs.stat(target)
    if (!lastRead) {
      throw new Error('File has not been read yet. Read it first before writing to it.')
    }
    if (stat.mtimeMs > lastRead.timestamp) {
      const contentUnchanged = lastRead.isFullRead && lastRead.content === (await fs.readFile(target, 'utf8'))
      if (!contentUnchanged) {
        throw new Error('File has been unexpectedly modified. Read it again before attempting to write it.')
      }
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content, 'utf8')
  // 写后更新 read state,后续 Edit 可继续
  readFileState.set(target, { content, timestamp: Date.now(), isFullRead: true })
  return { file_path: path.relative(path.resolve(workspace), target), chars: content.length, created: !exists }
}

async function editFileTool(workspace, filePath, oldString, newString, replaceAll = false) {
  const target = resolveWorkspacePath(workspace, filePath)
  // read-before-write:FileEditTool.ts:275-343 语义(未读拒绝 / 读后修改拒绝)
  const lastRead = readFileState.get(target)
  let stat
  try {
    stat = await fs.stat(target)
  } catch {
    throw new Error(`File not found: ${filePath}`)
  }
  if (!lastRead) {
    throw new Error('File has not been read yet. Read it first before writing to it.')
  }
  if (stat.mtimeMs > lastRead.timestamp) {
    // full read 且内容未变时放行(编辑自身会更新 read state,不会触发)
    const isFullRead = lastRead.isFullRead
    const contentUnchanged = isFullRead && lastRead.content === (await fs.readFile(target, 'utf8'))
    if (!contentUnchanged) {
      throw new Error('File has been unexpectedly modified. Read it again before attempting to write it.')
    }
  }
  const content = await fs.readFile(target, 'utf8')
  if (!content.includes(oldString)) throw new Error(`Old string not found in ${filePath}`)
  // 多匹配拒绝:FileEditTool.ts:329-343(errorCode 9 语义)——静默改第一处会改错函数
  const count = content.split(oldString).length - 1
  if (count > 1 && !replaceAll) {
    throw new Error(`Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`)
  }
  // 用函数替换避免 $&/$'/$` 等替换模板被解释(replace(string, string) 会解释 $ 序列)
  const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString)
  await fs.writeFile(target, updated, 'utf8')
  // 写后更新 read state(FileEditTool.ts:520-525 语义),后续编辑可继续
  readFileState.set(target, { content: updated, timestamp: Date.now(), isFullRead: lastRead.isFullRead })
  return { file_path: path.relative(path.resolve(workspace), target), replaced: replaceAll ? count : 1 }
}

// 断网环境网络命令拦截:SWE-bench 容器 --network none,这类"找外部源码/装包"命令
// 必然失败且空耗轮次(实测 19 个 no_patch 中 6 个在 pip download / pip cache / find *.whl 上白烧 10-20 轮)
const NETWORK_COMMAND_PATTERNS = [
  { re: /\b(pip|pip3)\s+(install|download|wheel)\b/, hint: 'pip install/download/wheel' },
  { re: /\b(pip|pip3)\s+cache\b/, hint: 'pip cache' },
  { re: /\b(curl|wget)\b/, hint: 'curl/wget' },
  { re: /\bgit\s+(fetch|clone|pull|push)\b/, hint: 'git fetch/clone/pull/push' },
  { re: /\b(npm|yarn|pnpm)\s+(install|add)\b/, hint: 'npm/yarn/pnpm install' },
  { re: /find\s+.*(\.cache|wheels|\.whl)/, hint: 'searching pip cache / wheels' },
]
function networkBlockReason(command) {
  for (const { re, hint } of NETWORK_COMMAND_PATTERNS) {
    if (re.test(command)) return hint
  }
  return null
}

export function runCommand(workspace, command, timeoutMs = 120_000, maxChars = DEFAULT_MAX_CHARS, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve({ command, exit_code: null, timed_out: false, aborted: true, stdout: '', stderr: '' })
      return
    }
    const child = spawn(command, { cwd: path.resolve(workspace), shell: true, env: process.env })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const terminate = () => child.kill('SIGTERM')
    const onAbort = () => {
      aborted = true
      terminate()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, Math.min(timeoutMs, 600_000))
    const append = (buf, chunk) => {
      buf += chunk
      if (maxChars > 0 && buf.length > maxChars) buf = buf.slice(-maxChars)
      return buf
    }
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ command, exit_code: timedOut || aborted ? null : code, timed_out: timedOut, aborted, stdout, stderr })
    })
  })
}

/**
 * 收集最终 patch: tracked diff + Git 原生渲染的未跟踪文件。
 * 供 harness 层(agent 结束)与测试使用,不再作为模型工具暴露。
 * (git.ts:613-788 / gitDiff.ts:504-532 语义)
 */
export async function collectGitDiff(workspace) {
  // Let Git render every file type itself. `git add -N` makes untracked files
  // visible to diff without putting content in the index, and avoids malformed
  // hand-written empty-file hunks such as `@@ -0,0 +1,0 @@`.
  const untracked = await runCommand(workspace, 'git ls-files --others --exclude-standard -z', 30_000, 0)
  if (untracked.exit_code !== 0) return { diff: '', error: untracked.stderr || 'git diff unavailable' }
  const files = untracked.stdout.split('\0').filter(Boolean)
  if (files.length) {
    const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`
    const staged = await runCommand(workspace, `git add --intent-to-add -- ${files.map(quote).join(' ')}`, 30_000, 0)
    if (staged.exit_code !== 0) return { diff: '', error: staged.stderr || 'git add intent-to-add failed' }
  }
  // patch extraction must not truncate stdout (50k truncation loses tail hunks).
  const result = await runCommand(workspace, 'git diff --no-ext-diff --binary', 30_000, 0)
  return result.exit_code === 0 ? { diff: result.stdout } : { diff: '', error: result.stderr || 'git diff unavailable' }
}

export async function executeTool(name, input, { workspace, permissions = [], permissionMode = 'default', agentRunner, askHandler, signal, commandRunner, displayWorkspace } = {}) {
  const definition = TOOL_DEFINITIONS.find(tool => tool.name === name)
  if (!definition) throw new Error(`Unknown tool: ${name}`)
  const cleanInput = { ...(input ?? {}) }
  for (const key of ['file_path', 'path', 'cwd']) {
    if (key in cleanInput) cleanInput[key] = translateDisplayPath(workspace, cleanInput[key], displayWorkspace)
  }
  validateInput(definition.input_schema, cleanInput)
  const decision = canUseTool(name, cleanInput, permissions, { mode: permissionMode })
  if (decision.behavior === 'ask') {
    // 交互环境:询问用户;无 askHandler(headless)直接拒绝
    const allowed = askHandler ? await askHandler({ toolName: name, input: cleanInput, message: decision.message }) : false
    if (!allowed) throw new Error(decision.message ?? `No permission to use ${name}.`)
  } else if (decision.behavior === 'deny') {
    throw new Error(decision.message)
  }
  switch (name) {
    case 'Read':
      return await readTextFile(workspace, cleanInput.file_path, cleanInput.offset, cleanInput.limit)
    case 'Write':
      return await writeFileTool(workspace, cleanInput.file_path, cleanInput.content)
    case 'Edit':
      return await editFileTool(workspace, cleanInput.file_path, cleanInput.old_string, cleanInput.new_string, cleanInput.replace_all ?? false)
    case 'Glob':
      return await globFiles(workspace, cleanInput.pattern, cleanInput.path)
    case 'Grep':
      return await grepText(workspace, cleanInput)
    case 'Bash': {
      const blocked = networkBlockReason(cleanInput.command)
      if (blocked) {
        return {
          command: cleanInput.command,
          exit_code: 1,
          stdout: '',
          stderr: `This environment has no network access (sandboxed). The command appears to need the network (${blocked}) and was blocked. Do not fetch external sources: work only from the repository source in the workspace.`,
        }
      }
      return await (commandRunner ?? runCommand)(workspace, cleanInput.command, cleanInput.timeout ?? 120_000, DEFAULT_MAX_CHARS, signal)
    }
    case 'Agent': {
      if (!agentRunner) throw new Error('Agent tool is unavailable in this context')
      const subWorkspace = cleanInput.cwd ? resolveWorkspacePath(workspace, cleanInput.cwd) : workspace
      const sub = await agentRunner({
        prompt: cleanInput.prompt,
        workspace: subWorkspace,
        maxTurns: cleanInput.max_turns ?? 8,
        model: cleanInput.model,
        signal,
      })
      return { result: sub.finalText, turns: sub.turns, compactedCount: sub.compactedCount }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
