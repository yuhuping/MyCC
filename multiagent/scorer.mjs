// multiagent/scorer.mjs
// 按 MultiAgentBench(MARBLE) 官方 evaluator.py evaluate_code_quality 口径评分：
//   prompt 原文照搬（4 维度 1-5 分、严格扣分、JSON 输出），judge 走 MyCC 的
//   Responses 模型链路（deepseek-v4-flash）。输出 JSON 到 --out。
//
// 用法:
//   node multiagent/scorer.mjs \
//     --task-json ./data/task-1.json --solution ./work/1/solution.py --out ./out/1.scored.json
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { judgeOnce } from './lib/judge.mjs'
import { responsesConfig, loadEnv } from './lib/env.mjs'

// 官方 evaluator.py 的 requirements 切分标记（100 条数据全部命中）
const REQ_START = '1. Implementation requirements:\n'
const REQ_END = '\n\n2. Project structure:'

function extractRequirements(content) {
  const start = content.indexOf(REQ_START)
  const end = content.indexOf(REQ_END)
  if (start === -1 || end === -1) return ''
  return content.slice(start + REQ_START.length, end).trim()
}

// 官方 evaluate_code_quality 的 judge prompt（逐字保留）
const CODE_QUALITY_PROMPT = `
                    [Context]
                    **Task Description:**
                    {task_description}

                    **Implementation Requirements:**
                    {requirements}

                    **Current Solution:**
                    {solution}

                    [System]
                    This evaluation requires strict scoring and deduction. The scores should not be generous, and deductions should be applied for every issue found.

                    ### **Evaluation Criteria**
                    1. **Instruction-Following:** Does the code fulfill all the requirements of the task? Deduct points for unmet or partially met requirement from the task instructions.
                    2. **Executability:** Is the code syntactically correct and executable? Deduct points for any syntax errors, missing imports, or runtime errors.
                    3. **Consistency:** Is the code consistent in variable naming, formatting, and logic? Deduct points for inconsistent variable naming, formatting issues, or contradictory logic.
                    4. **Quality:** Is the code well-documented, clear, and modular? Deduct points for poor documentation, unclear logic, or lack of modular design.

                    ### **Scoring**
                    - **1 point:** Below Average - Significant issues that need addressing.
                    - **2 points:** Average - Noticeable areas for improvement.
                    - **3 points:** Good - Minor issues or improvements needed.
                    - **4 points:** Excellent - Almost or fully satisfies the criterion.
                    - **5 points:** Legendary - Flawless, perfectly satisfies the criterion, and exceeds expectations.

                    **Do not give the same scores for different criteria, such as 3 for instruction-following, 3 for executability, 3 for consistency, and 3 for quality.**
                    If you give the same scores for the 4 criteria, you have to add or deduct 1 point randomly for one or two criteria.

                    ### **Question**
                    Based on the criteria, evaluate the code and output the scores for each criterion in the following JSON format:
                    {{
                        "instruction_following": score,
                        "executability": score,
                        "consistency": score,
                        "quality": score
                    }}
            `

export function buildScorePrompt(taskContent, solutionContent) {
  return CODE_QUALITY_PROMPT
    .replace('{task_description}', taskContent)
    .replace('{requirements}', extractRequirements(taskContent) || '(none extracted)')
    .replace('{solution}', solutionContent || '(no solution file)')
}

export function parseScores(text) {
  if (!text) return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0])
    const keys = ['instruction_following', 'executability', 'consistency', 'quality']
    const scores = {}
    for (const k of keys) {
      const v = Number(obj[k])
      if (!Number.isFinite(v)) return null
      scores[k] = v
    }
    return scores
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const opts = { taskJson: null, solution: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task-json') opts.taskJson = argv[++i]
    else if (argv[i] === '--solution') opts.solution = argv[++i]
    else if (argv[i] === '--out') opts.out = argv[++i]
    else if (argv[i] === '--judge-model') opts.judgeModel = argv[++i]
  }
  return opts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.taskJson || !opts.solution) {
    console.error('usage: node scorer.mjs --task-json <task.json> --solution <solution.py> [--out <out.json>] [--judge-model M]')
    process.exit(2)
  }
  const task = JSON.parse(fs.readFileSync(opts.taskJson, 'utf8'))
  const solution = fs.existsSync(opts.solution) ? fs.readFileSync(opts.solution, 'utf8') : ''
  const taskContent = typeof task.task?.content === 'string' ? task.task.content : String(task.task?.content ?? '')
  const prompt = buildScorePrompt(taskContent, solution)

  const judgeCfg = responsesConfig(loadEnv())
  const { text, usage, attempts } = await judgeOnce(prompt, {
    model: opts.judgeModel,
    // 官方 max_token_num=4096 是给 gpt-4o-mini 的；deepseek-v4-flash 为
    // reasoning 模型，评分大型 solution 时推理可达 13k~18k token，给足预算
    // 避免 response.incomplete 空返回（评分口径不变）。超时同步放宽：
    // reasoning 13k+ token 的流式输出可能耗时 5-10 分钟。
    maxTokens: 32_000,
    temperature: 0,
    timeoutMs: 600_000,
  })
  const scores = parseScores(text)

  const result = {
    task_id: task.task_id ?? task.id ?? null,
    judge_model: opts.judgeModel ?? judgeCfg.model,
    scores,
    raw: text,
    attempts,
    usage,
    solution_bytes: Buffer.byteLength(solution, 'utf8'),
  }
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true })
    fs.writeFileSync(opts.out, JSON.stringify(result, null, 2))
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('scorer error:', e.message); process.exit(1) })
}