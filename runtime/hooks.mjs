// runtime/hooks.mjs
// Hook 生命周期:settings 配置解析 + command hook 执行器(stdio JSON 协议)。
// 移植自 src/schemas/hooks.ts(配置结构)、src/utils/hooks/(执行模型),
// 只支持 type: 'command';prompt/http/agent hook 类型暂不实现。

import { spawn } from 'node:child_process'
import { permissionRuleValueFromString, parsePermissionRule, matchWildcardPattern } from './permissions.mjs'

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
]

/**
 * 解析 settings JSON 的 hooks 字段。
 * @param {object|null} settingsJson 形如 { hooks: { PreToolUse: [{ matcher?, hooks: [{ type:'command', command }] }] } }
 * @returns {Record<string, Array<{matcher?: string, hooks: Array<{type:'command', command: string, timeout?: number}>}>>}
 */
export function parseHooksSettings(settingsJson) {
  if (!settingsJson || !settingsJson.hooks || typeof settingsJson.hooks !== 'object') return {}
  const result = {}
  for (const [eventName, matchers] of Object.entries(settingsJson.hooks)) {
    if (!HOOK_EVENTS.includes(eventName) || !Array.isArray(matchers)) continue
    const cleaned = []
    for (const matcher of matchers) {
      if (!matcher || typeof matcher !== 'object' || !Array.isArray(matcher.hooks)) continue
      const hooks = matcher.hooks
        .filter(hook => hook && hook.type === 'command' && typeof hook.command === 'string')
        .map(hook => ({
          type: 'command',
          command: hook.command,
          timeout: typeof hook.timeout === 'number' && hook.timeout > 0 ? hook.timeout : undefined,
        }))
      if (hooks.length) cleaned.push({ matcher: matcher.matcher, hooks })
    }
    if (cleaned.length) result[eventName] = cleaned
  }
  return result
}

// matcher 匹配:空 = 全部;整工具名;或 "Tool(content)" 规则(对 tool_input.command)
function hookMatches(matcher, input) {
  if (!matcher) return true
  const toolName = input.tool_name
  const ruleValue = permissionRuleValueFromString(matcher)
  if (ruleValue.ruleContent === undefined) return ruleValue.toolName === toolName
  const command = input.tool_input?.command
  if (typeof command !== 'string') return false
  const parsed = parsePermissionRule(ruleValue.ruleContent)
  if (parsed.type === 'exact') return command === parsed.command
  if (parsed.type === 'prefix') {
    if (command === parsed.prefix) return true
    return command.startsWith(parsed.prefix + ' ')
  }
  return matchWildcardPattern(parsed.pattern, command)
}

/** 执行一个 command hook:stdin 写 JSON input,stdout 解析 JSON output */
function runCommandHook(hook, input, defaultTimeoutMs = 60_000) {
  return new Promise(resolve => {
    const child = spawn(hook.command, { shell: true, env: process.env, cwd: input?.cwd || process.cwd() })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeoutMs = (hook.timeout ?? defaultTimeoutMs) * 1000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      resolve({ timed_out: true, stderr, decision: undefined, additionalContext: undefined })
    }, timeoutMs)
    child.stdin.on('error', () => {})
    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(parseHookOutput(stdout, code => code))
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ error: error.message, decision: undefined, additionalContext: undefined })
    })
  })
}

function parseHookOutput(stdout) {
  // stdout 最后一行是 JSON;前导行可能是日志
  const lines = stdout.split('\n').filter(line => line.trim())
  let json = null
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      json = JSON.parse(lines[i])
      break
    } catch {
      // 继续向前找 JSON 行
    }
  }
  if (!json || typeof json !== 'object') return { decision: undefined, additionalContext: undefined, stdout }
  const decision = ['block', 'allow', 'deny', 'ask', 'continue'].includes(json.decision) ? json.decision : undefined
  return {
    ...json, // 透传 hook 自定义输出(hookSpecificOutput 等)
    decision,
    additionalContext: json.additionalContext,
    suppressOutput: json.suppressOutput === true,
    updatedInput: json.updatedInput && typeof json.updatedInput === 'object' ? json.updatedInput : undefined,
    stdout,
  }
}

/**
 * 执行某事件的所有匹配 hook(串行);遇 decision==='block' 短路。
 * @param {object} hooksConfig parseHooksSettings 的产物
 * @param {string} eventName Hook 事件名
 * @param {object} input 事件输入(至少含 session_id/cwd/tool_name/tool_input/hook_event_name)
 * @returns {Promise<Array<object>>} 各 hook 结果
 */
export async function executeHooks(hooksConfig, eventName, input, { timeoutSeconds = 60 } = {}) {
  const matchers = hooksConfig[eventName] ?? []
  const results = []
  for (const matcher of matchers) {
    if (!hookMatches(matcher.matcher, input)) continue
    for (const hook of matcher.hooks) {
      const result = await runCommandHook(hook, input, timeoutSeconds)
      result.hook = hook
      result.matcher = matcher.matcher
      results.push(result)
      if (result.decision === 'block') return results
    }
  }
  return results
}

/** 汇总某事件 hook 是否阻断 */
export function isBlocked(results) {
  return results.some(result => result.decision === 'block')
}

/** 汇总 additionalContext(字符串或字符串数组) */
export function collectAdditionalContext(results) {
  const contexts = []
  for (const result of results) {
    if (!result || result.additionalContext === undefined) continue
    const values = Array.isArray(result.additionalContext) ? result.additionalContext : [result.additionalContext]
    for (const value of values) if (typeof value === 'string') contexts.push(value)
  }
  return contexts
}
