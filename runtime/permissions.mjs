// runtime/permissions.mjs
// 权限系统:规则解析 + 工具调用判定。移植自 src/utils/permissions/ 的纯逻辑,
// 裁剪了 feature()/bootstrap/analytics/classifier/hook/sandbox 等全部环境耦合。

// ---------- 类型 ----------
// PermissionRule = { source: string, ruleBehavior: 'allow'|'deny'|'ask',
//                    ruleValue: { toolName: string, ruleContent?: string } }

// ---------- 字符串解析(permissionRuleParser.ts 纯逻辑) ----------

const LEGACY_TOOL_NAME_ALIASES = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  AgentOutputTool: 'TaskOutput',
  BashOutputTool: 'TaskOutput',
}

export function normalizeLegacyToolName(name) {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name
}

export function escapeRuleContent(content) {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

export function unescapeRuleContent(content) {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

function findFirstUnescapedChar(str, char) {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) {
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') { backslashCount++; j-- }
      if (backslashCount % 2 === 0) return i
    }
  }
  return -1
}

function findLastUnescapedChar(str, char) {
  for (let i = str.length - 1; i >= 0; i--) {
    if (str[i] === char) {
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && str[j] === '\\') { backslashCount++; j-- }
      if (backslashCount % 2 === 0) return i
    }
  }
  return -1
}

export function permissionRuleValueFromString(ruleString) {
  const openParenIndex = findFirstUnescapedChar(ruleString, '(')
  if (openParenIndex === -1) return { toolName: normalizeLegacyToolName(ruleString) }

  const closeParenIndex = findLastUnescapedChar(ruleString, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }
  if (closeParenIndex !== ruleString.length - 1) {
    return { toolName: normalizeLegacyToolName(ruleString) }
  }

  const toolName = ruleString.substring(0, openParenIndex)
  const rawContent = ruleString.substring(openParenIndex + 1, closeParenIndex)
  if (!toolName) return { toolName: normalizeLegacyToolName(ruleString) }
  // "Bash()" 与 "Bash(*)" 归一为整工具规则
  if (rawContent === '' || rawContent === '*') {
    return { toolName: normalizeLegacyToolName(toolName) }
  }
  return { toolName: normalizeLegacyToolName(toolName), ruleContent: unescapeRuleContent(rawContent) }
}

export function permissionRuleValueToString(ruleValue) {
  if (!ruleValue.ruleContent) return ruleValue.toolName
  return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}

// ---------- settings JSON → 规则(permissionsLoader.ts 纯逻辑) ----------

const SUPPORTED_RULE_BEHAVIORS = ['allow', 'deny', 'ask']

export function parseRules(settingsJson, source = 'settings') {
  if (!settingsJson || !settingsJson.permissions) return []
  const { permissions } = settingsJson
  const rules = []
  for (const behavior of SUPPORTED_RULE_BEHAVIORS) {
    const behaviorArray = permissions[behavior]
    if (Array.isArray(behaviorArray)) {
      for (const ruleString of behaviorArray) {
        rules.push({ source, ruleBehavior: behavior, ruleValue: permissionRuleValueFromString(ruleString) })
      }
    }
  }
  return rules
}

// 合并多来源(优先级:后出现的 source 覆盖同规则,判定时取先命中)
export function mergeRules(...ruleGroups) {
  return ruleGroups.flat()
}

// ---------- 整工具匹配(permissions.ts:238-269 纯逻辑) ----------

function mcpInfoFromString(toolString) {
  const parts = toolString.split('__')
  const [mcpPart, serverName, ...toolNameParts] = parts
  if (mcpPart !== 'mcp' || !serverName) return null
  return { serverName, toolName: toolNameParts.length > 0 ? toolNameParts.join('__') : undefined }
}

function toolMatchesRule(nameForRuleMatch, rule) {
  // 有 ruleContent 的规则不参与整工具匹配
  if (rule.ruleValue.ruleContent !== undefined) return false
  if (rule.ruleValue.toolName === nameForRuleMatch) return true

  // MCP server 级规则:mcp__server1 匹配 mcp__server1__tool1
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(nameForRuleMatch)
  return (
    ruleInfo !== null && toolInfo !== null &&
    (ruleInfo.toolName === undefined || ruleInfo.toolName === '*') &&
    ruleInfo.serverName === toolInfo.serverName
  )
}

function getRuleByContentsForToolName(rules, toolName, behavior) {
  const ruleByContents = new Map()
  for (const rule of rules) {
    if (
      rule.ruleValue.toolName === toolName &&
      rule.ruleValue.ruleContent !== undefined &&
      rule.ruleBehavior === behavior
    ) {
      ruleByContents.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return ruleByContents
}

// ---------- Bash 命令规则三态匹配(shellRuleMatching.ts 纯逻辑) ----------

const ESCAPED_STAR_PLACEHOLDER = '\x00ESCAPED_STAR\x00'
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00'

export function permissionRuleExtractPrefix(permissionRule) {
  const match = permissionRule.match(/^(.+):\*$/)
  return match?.[1] ?? null
}

export function hasWildcards(pattern) {
  if (pattern.endsWith(':*')) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*') {
      let backslashCount = 0
      let j = i - 1
      while (j >= 0 && pattern[j] === '\\') { backslashCount++; j-- }
      if (backslashCount % 2 === 0) return true
    }
  }
  return false
}

export function matchWildcardPattern(pattern, command, caseInsensitive = false) {
  const trimmedPattern = pattern.trim()
  let processed = ''
  let i = 0
  while (i < trimmedPattern.length) {
    const char = trimmedPattern[i]
    if (char === '\\' && i + 1 < trimmedPattern.length) {
      const nextChar = trimmedPattern[i + 1]
      if (nextChar === '*') { processed += ESCAPED_STAR_PLACEHOLDER; i += 2; continue }
      if (nextChar === '\\') { processed += ESCAPED_BACKSLASH_PLACEHOLDER; i += 2; continue }
    }
    processed += char
    i++
  }
  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, '\\$&')
  const withWildcards = escaped.replace(/\*/g, '.*')
  let regexPattern = withWildcards
    .replace(new RegExp(ESCAPED_STAR_PLACEHOLDER, 'g'), '\\*')
    .replace(new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, 'g'), '\\\\')
  const unescapedStarCount = (processed.match(/\*/g) || []).length
  if (regexPattern.endsWith(' .*') && unescapedStarCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + '( .*)?'
  }
  const flags = 's' + (caseInsensitive ? 'i' : '')
  return new RegExp(`^${regexPattern}$`, flags).test(command)
}

export function parsePermissionRule(permissionRule) {
  const prefix = permissionRuleExtractPrefix(permissionRule)
  if (prefix !== null) return { type: 'prefix', prefix }
  if (hasWildcards(permissionRule)) return { type: 'wildcard', pattern: permissionRule }
  return { type: 'exact', command: permissionRule }
}

// 剥离前导 env 赋值(FOO=bar cmd → cmd),deny/ask 规则用,防绕过。
// 值不允许含 shell 元字符(; & | 反引号 空白),否则截断到首个元字符
function stripAllLeadingEnvVars(command) {
  let rest = command.trimStart()
  while (true) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=[^\s;&|`]*/)
    if (!m) break
    rest = rest.slice(m[0].length).trimStart()
  }
  return rest
}

// 提取命令替换片段($(cmd) / ${var} / `cmd`),deny/ask 方向额外参与匹配,
// 防 FOO=$(rm -rf /) 这类 env 值里的命令替换绕过剥离后失配
function commandSubstitutionFragments(command) {
  const fragments = []
  const re = /\$\(([^()]*)\)|\$\{([^}]*)\}|`([^`]*)`/g
  let match
  while ((match = re.exec(command))) fragments.push(match[1] ?? match[2] ?? match[3])
  return fragments
}

// 按 shell 复合分隔符拆分子命令(简化版,不处理引号;src 用 splitCommand 能力)
function splitCommand(command) {
  return command.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean)
}

// 内容规则匹配。
// - deny/ask 方向(stripEnv=true, matchAll=false):先剥离 env、再拆子命令,任一命中即命中(危险子命令拦下)
// - allow 方向(stripEnv=false, matchAll=true):不剥离 env,全部子命令都命中才命中(任一未命中即不放行)
function matchBashRule(ruleContent, command, { stripEnv = false, matchAll = false } = {}) {
  const parsed = parsePermissionRule(ruleContent)
  const matchOne = sub => {
    if (parsed.type === 'exact') return sub === parsed.command
    if (parsed.type === 'prefix') {
      const { prefix } = parsed
      // 词边界:sub === prefix 或 sub.startsWith(prefix + ' ')
      if (sub === prefix) return true
      return sub.startsWith(prefix + ' ')
    }
    return matchWildcardPattern(parsed.pattern, sub)
  }
  if (stripEnv) {
    // deny/ask:先拆分子命令再逐个子命令剥离 env(防 FOO=bar&&rm 结构),
    // 并把命令替换片段($(cmd)/${var})从原始命令提取出来一起匹配(防 FOO="$(rm -rf /)" 绕过)
    const subs = splitCommand(command).map(stripAllLeadingEnvVars).filter(Boolean)
    subs.push(...commandSubstitutionFragments(command))
    return subs.some(matchOne)
  }
  // allow:不剥离 env,全部子命令都命中才放行(任一未命中即不放行)
  return splitCommand(command).filter(Boolean).every(matchOne)
}

// ---------- 文件 glob 内容规则(filesystem.ts 语义,手写 glob→RegExp) ----------

function expandBraces(pattern) {
  const match = String(pattern).match(/\{([^{}]+)\}/)
  if (!match) return [String(pattern)]
  const prefix = pattern.slice(0, match.index)
  const suffix = pattern.slice(match.index + match[0].length)
  return match[1].split(',').flatMap(part => expandBraces(prefix + part + suffix))
}

function singleGlobToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') { re += '(?:.*/)?'; i += 2 }
        else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const base = normalized.includes('/') ? '' : '(?:.*/)?'
  return `${base}${re}`
}

/** glob 转 RegExp:* 不跨目录、** 跨目录、? 单字符、{a,b} 展开;pattern 无 / 时匹配任意层级 */
export function globToRegExp(pattern) {
  const alternatives = expandBraces(String(pattern)).map(singleGlobToRegExp)
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

function findMatchingGlobRule(rules, toolName, behavior, filePath) {
  const ruleByContents = getRuleByContentsForToolName(rules, toolName, behavior)
  if (ruleByContents.size === 0) return null
  for (const [ruleContent, rule] of ruleByContents) {
    if (globToRegExp(ruleContent).test(filePath)) return rule
  }
  return null
}

// ---------- 判定链(permissions.ts:1158-1319 裁剪版) ----------

/**
 * 判定一次工具调用。
 * @param {string} toolName 工具名
 * @param {Record<string, unknown>} input 工具入参
 * @param {PermissionRule[]} rules 规则列表(空数组 = 不启用权限检查,全部放行)
 * @param {{ mode?: string, command?: string }} [opts] mode: default|acceptEdits|bypassPermissions|dontAsk|plan
 * @returns {{ behavior: 'allow'|'deny', message?: string, matchedRule?: object }}
 */
export function canUseTool(toolName, input, rules, opts = {}) {
  const mode = opts.mode ?? 'default'
  if (!rules || rules.length === 0) return { behavior: 'allow' }
  const command = input?.command ?? opts.command

  // 1a. 整工具 deny
  const denyRule = rules.find(r => r.ruleBehavior === 'deny' && toolMatchesRule(toolName, r))
  if (denyRule) {
    return { behavior: 'deny', message: `Permission to use ${toolName} has been denied.`, matchedRule: denyRule }
  }

  // 1b. 整工具 ask(无交互环境:bypass 放行,否则拒绝)
  const askRule = rules.find(r => r.ruleBehavior === 'ask' && toolMatchesRule(toolName, r))
  if (askRule) {
    return decideAsk(toolName, mode, askRule)
  }

  // 1c. 内容规则(仅对带 command 的工具,如 Bash,做三态匹配)
  if (command) {
    // deny/ask:剥离 env + 任一子命令命中即拒(防 FOO=bar&&rm 绕过)
    const contentDeny = findMatchingContentRule(rules, toolName, 'deny', command, { stripEnv: true, matchAll: false })
    if (contentDeny) {
      return { behavior: 'deny', message: `Permission to run \`${command}\` has been denied.`, matchedRule: contentDeny }
    }
    const contentAsk = findMatchingContentRule(rules, toolName, 'ask', command, { stripEnv: true, matchAll: false })
    if (contentAsk) {
      return decideAsk(toolName, mode, contentAsk)
    }
    // allow:不剥离 env,全部子命令命中才放行
    const contentAllow = findMatchingContentRule(rules, toolName, 'allow', command, { stripEnv: false, matchAll: true })
    if (contentAllow) {
      return { behavior: 'allow', matchedRule: contentAllow }
    }
  }

  // 1d. 文件工具的 glob 内容规则(Write/Edit/Read 等,src filesystem.ts 语义)
  const filePath = input?.path ?? input?.file_path
  if (typeof filePath === 'string') {
    const globDeny = findMatchingGlobRule(rules, toolName, 'deny', filePath)
    if (globDeny) return { behavior: 'deny', message: `Permission to access \`${filePath}\` has been denied.`, matchedRule: globDeny }
    const globAsk = findMatchingGlobRule(rules, toolName, 'ask', filePath)
    if (globAsk) return decideAsk(toolName, mode, globAsk)
    const globAllow = findMatchingGlobRule(rules, toolName, 'allow', filePath)
    if (globAllow) return { behavior: 'allow', matchedRule: globAllow }
  }

  // 2a. bypass 模式
  if (mode === 'bypassPermissions' || mode === 'plan') {
    return { behavior: 'allow' }
  }

  // 2b. 整工具 allow
  const allowRule = rules.find(r => r.ruleBehavior === 'allow' && toolMatchesRule(toolName, r))
  if (allowRule) {
    return { behavior: 'allow', matchedRule: allowRule }
  }

  // 3. passthrough → 无交互环境默认放行(保持 headless 可跑)
  return { behavior: 'allow' }
}

const EDIT_TOOL_NAMES = new Set(['Write', 'Edit'])

function decideAsk(toolName, mode, askRule) {
  // bypassPermissions/plan:全部放行
  if (mode === 'bypassPermissions' || mode === 'plan') {
    return { behavior: 'allow', matchedRule: askRule }
  }
  // acceptEdits:仅自动接受编辑类工具
  if (mode === 'acceptEdits' && EDIT_TOOL_NAMES.has(toolName)) {
    return { behavior: 'allow', matchedRule: askRule }
  }
  // 其他模式:返回 ask,由调用方(executeTool)决定询问用户或拒绝
  return { behavior: 'ask', message: `Claude requested permissions to use ${toolName}.`, matchedRule: askRule }
}

// 内容 deny/ask 规则匹配时,命令先剥离前导 env 赋值
function findMatchingContentRule(rules, toolName, behavior, command, { stripEnv = false, matchAll = false } = {}) {
  const ruleByContents = getRuleByContentsForToolName(rules, toolName, behavior)
  if (ruleByContents.size === 0) return null
  for (const [ruleContent, rule] of ruleByContents) {
    if (matchBashRule(ruleContent, command, { stripEnv, matchAll })) return rule
  }
  return null
}

// ---------- 便捷:从文件加载 settings 权限 ----------

import { promises as fs } from 'node:fs'

export async function loadRulesFromFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  const json = JSON.parse(raw)
  return parseRules(json, filePath)
}
