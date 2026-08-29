// multiagent/selfmade/lead-smoke.mjs
// 离线集成冒烟：用 stub provider（不调用 LLM）跑完整 lead-parallel DAG，
// 验证：lead 脚手架 -> workerA/workerB 并行隔离 patch（并通过团队信道互发消息）
// -> 机械集成 -> 测试门禁；断言并发、团队消息、产物、集成状态。
// 运行：node multiagent/selfmade/lead-smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { runPlannedTask, AgentGraph } from '../lib/coordinator.mjs'
import { validatePlan } from '../lib/execution-plan.mjs'
import { initGitRepo } from '../lib/worktree.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const task = JSON.parse(fs.readFileSync(path.join(ROOT, 'multiagent', 'selfmade', 'tasks.jsonl'), 'utf8').trim().split('\n')[0])
const plan = JSON.parse(fs.readFileSync(path.join(ROOT, 'multiagent', 'selfmade', 'plans', 'lead-parallel.json'), 'utf8'))

const graph = AgentGraph.fromConfig(task.agents ?? [], task.relationships ?? [])

// ---------- 各角色 stub 的“完美实现”内容（task 0: wordstats） ----------

const TEXTS = {
  solution: `import argparse
from modules.textx import word_stats, word_frequency
from modules.strutil import reverse_words, is_palindrome, acronym

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--text', default='Hello world! Hello again.')
    args = p.parse_args()
    print(word_stats(args.text))
    print(word_frequency(args.text, 'hello'))
    print(reverse_words(args.text))
    print(is_palindrome(args.text))
    print(acronym(args.text))

if __name__ == '__main__':
    main()
`,
  textx: `import re
_WORDS = re.compile(r'[A-Za-z0-9]+')

def _tokens(text):
    return _WORDS.findall(text or '')

def word_stats(text):
    toks = _tokens(text)
    counts = {}
    for t in toks:
        counts[t] = counts.get(t, 0) + 1
    top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
    return {'words': len(toks), 'chars': len(text or ''), 'lines': (text or '').count('\\n') + 1,
            'unique_words': len(counts), 'top_words': top}

def word_frequency(text, word):
    return sum(1 for t in _tokens(text) if t.lower() == word.lower())
`,
  strutil: `def reverse_words(text):
    parts = (text or '').split()
    return ' '.join(parts[::-1])

def is_palindrome(text):
    s = ''.join(ch for ch in (text or '').lower() if ch.isalnum())
    return s == s[::-1] and bool(s)

def acronym(text):
    return ''.join(w[0].upper() for w in (text or '').split() if w)
`,
  test: `import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from modules.textx import word_stats, word_frequency
from modules.strutil import reverse_words, is_palindrome, acronym

text = 'Hello world! Hello again.'
assert word_stats(text)['words'] == 4
assert word_stats(text)['unique_words'] == 3
assert word_frequency(text, 'HELLO') == 2
assert reverse_words(text) == 'again. Hello world! Hello'
assert is_palindrome('A man, a plan, a canal: Panama')
assert not is_palindrome('hello')
assert acronym('hello world from') == 'HWF'
print('ALL TESTS PASSED')
`,
}

// ---------- stub provider：按 agentId 状态机执行“理想 agent”动作 ----------

function makeStub() {
  const stubs = new Map() // agentId -> step index
  const provider = async ({ system, messages, tools, maxTokens, signal, onEvent }) => {
    // AgentInstance 的 prompt（含角色/交付物说明）在首条 user 消息里，system 只有通用系统提示；
    // agentId / base 都要从完整文本里找。
    const allText = [String(system ?? '')]
      .concat((Array.isArray(messages) ? messages : []).map(m => {
        const c = m?.content
        return Array.isArray(c) ? c.map(b => (b?.type === 'text' ? b.text : (b?.type === 'tool_result' ? JSON.stringify(b) : ''))).join('\n') : String(c ?? '')
      }))
      .join('\n')
    const agentId = (allText.match(/"agent_id": "([^"]+)"/) ?? [])[1] ?? 'unknown'
    // 优先取上下文里“Your workspace base”行的 checkout SHA（即本 node 的 base_revision）
    const checkoutBase = (allText.match(/Checkout base SHA[\s\S]*?:\s*([0-9a-f]{7,40})/) ?? [])[1]
      ?? (allText.match(/base=([0-9a-f]{7,40})/) ?? [])[1]
      ?? 'unknown'
    const i = stubs.get(agentId) ?? 0
    stubs.set(agentId, i + 1)

    const text = (blocks) => blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
    const lastMsg = Array.isArray(messages) ? messages.at(-1) : null
    const lastContent = lastMsg?.content ?? []
    const lastBlocks = Array.isArray(lastContent) ? lastContent : [{ type: 'text', text: String(lastContent ?? '') }]
    const lastText = text(lastBlocks)

    const toolUse = (name, input, id) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 } })
    const done = (finalText) => ({ content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 } })

    if (agentId === 'lead') {
      if (i === 0) return toolUse('Write', { file_path: 'solution.py', content: TEXTS.solution }, 'c1')
      if (i === 1) return toolUse('Write', { file_path: 'modules/__init__.py', content: '' }, 'c2')
      if (i === 2) return toolUse('Write', { file_path: 'test_solution.py', content: TEXTS.test }, 'c3')
      if (i === 3) return toolUse('postTeamMessage', { message: 'Contract: tokens = [A-Za-z0-9]+; workers, announce your signatures.', to: null }, 'c4')
      return done('Scaffold ready.\n```json\n{"node_id":"lead-design","agent_id":"lead","modules":["modules/textx.py","modules/strutil.py"],"ownership":{"modules/textx.py":"workerA","modules/strutil.py":"workerB"},"acceptance":["python3 test_solution.py"],"summary":"scaffold + contract announced"}\n```')
    }
    if (agentId === 'workerA') {
      if (i === 0) return toolUse('postTeamMessage', { message: 'workerA: implementing modules/textx.py with word_stats/word_frequency, regex [A-Za-z0-9]+.', to: null }, 'a1')
      if (i === 1) return toolUse('getTeamMessages', {}, 'a2')
      if (i === 2) return toolUse('Write', { file_path: 'modules/textx.py', content: TEXTS.textx }, 'a3')
      const base = checkoutBase
      const artifact = {
        node_id: 'worker-A', agent_id: 'workerA', base_revision: base,
        files: ['modules/textx.py'],
        test_commands: ["python3 -c \"import sys; sys.path.insert(0, '.'); from modules.textx import word_frequency; assert word_frequency('A a b','a')==2; print('ok')\""],
        summary: 'word_stats + word_frequency implemented, regex split',
      }
      return done('textx done.\n```json\n' + JSON.stringify(artifact) + '\n```')
    }
    if (agentId === 'workerB') {
      if (i === 0) return toolUse('postTeamMessage', { message: 'workerB: implementing modules/strutil.py with reverse_words/is_palindrome/acronym.', to: null }, 'b1')
      if (i === 1) return toolUse('getTeamMessages', {}, 'b2')
      if (i === 2) return toolUse('Write', { file_path: 'modules/strutil.py', content: TEXTS.strutil }, 'b3')
      const base = checkoutBase
      const artifact = {
        node_id: 'worker-B', agent_id: 'workerB', base_revision: base,
        files: ['modules/strutil.py'],
        test_commands: ["python3 -c \"import sys; sys.path.insert(0, '.'); from modules.strutil import acronym; assert acronym('hello world from')=='HWF'; print('ok')\""],
        summary: 'reverse_words + is_palindrome + acronym implemented',
      }
      return done('strutil done.\n```json\n' + JSON.stringify(artifact) + '\n```')
    }
    if (agentId === 'integrator') {
      if (i === 0) return toolUse('getTeamMessages', {}, 'i1')
      const base = checkoutBase
      const artifact = {
        node_id: 'integrate', agent_id: 'integrator', base_revision: base,
        decisions: [
          { source: 'worker-A', artifact: 'patch.diff', adopted: true, reason: 'new file modules/textx.py' },
          { source: 'worker-B', artifact: 'patch.diff', adopted: true, reason: 'new file modules/strutil.py' },
        ],
        conflicts: [], stale_patches: [], test_commands: [],
        summary: 'both worker patches applied cleanly',
      }
      return done('Integrated.\n```json\n' + JSON.stringify(artifact) + '\n```')
    }
    if (agentId === 'verifier') {
      if (i === 0) return toolUse('getTeamMessages', {}, 'v1')
      const base = checkoutBase
      const artifact = {
        node_id: 'verify', agent_id: 'verifier', base_revision: base,
        commands: ['python3 test_solution.py'], evidence: 'run in main workspace', defects: [],
      }
      return done('Verified.\n```json\n' + JSON.stringify(artifact) + '\n```')
    }
    throw new Error(`stub: unknown agentId ${agentId}`)
  }
  return provider
}

// ---------- 运行 ----------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-smoke-'))
const outDir = path.join(workDir, 'out')
fs.mkdirSync(path.join(workDir, 'work-src'), { recursive: true })
await initGitRepo(path.join(workDir, 'work-src'))

const validated = validatePlan(plan, graph)
assert.ok(validated.id === 'lead-parallel-v1')

const events = []
const summary = await runPlannedTask({
  graph,
  task: task.task.content,
  workspace: path.join(workDir, 'work-src'),
  provider: makeStub(),
  plan: validated,
  sessionDirBase: path.join(outDir, 'sessions'),
  artifactDirBase: path.join(outDir, 'artifacts'),
  worktreeDirBase: path.join(outDir, 'worktrees'),
  maxTurnsPerAgent: 20,
  maxParallelAgents: 3,
  repairLoops: 1,
  taskId: 77,
  onEvent: ev => events.push(ev),
})

const ws = path.join(workDir, 'work-src')
for (const n of summary.nodes) {
  if (n.status !== 'succeeded') console.error(`[node] ${n.node_id} ${n.status} ${n.failure_reason ?? ''} artifacts=${JSON.stringify(n.artifact_paths)}`)
}
assert.equal(summary.status, 'succeeded', `run status (events: ${events.map(e => e.event).join(',')})`)
assert.equal(summary.integration_status, 'passed', 'integration passed')
assert.equal(summary.observed_max_concurrency, 2, 'workerA+workerB ran in parallel')
assert.equal(summary.team_message_count, 3, 'lead + workerA + workerB posted')
assert.ok(summary.team_read_count >= 3, 'team messages were read by teammates')
assert.ok(fs.existsSync(path.join(ws, 'solution.py')), 'solution.py exists')
assert.ok(fs.existsSync(path.join(ws, 'modules', 'textx.py')), 'workerA module integrated')
assert.ok(fs.existsSync(path.join(ws, 'modules', 'strutil.py')), 'workerB module integrated')
assert.ok(fs.existsSync(path.join(outDir, 'artifacts', 'lead-design', 'lead.json')), 'lead.json artifact')
const leadArt = JSON.parse(fs.readFileSync(path.join(outDir, 'artifacts', 'lead-design', 'lead.json'), 'utf8'))
assert.deepEqual(leadArt.modules, ['modules/textx.py', 'modules/strutil.py'])
// 团队消息内容断言
const froms = summary.team_messages.map(m => m.from)
assert.ok(froms.includes('lead') && froms.includes('workerA') && froms.includes('workerB'), `posters: ${froms.join(',')}`)

console.log('lead-smoke: OK — status=%s integration=%s concurrency=%d team_msgs=%d team_reads=%d',
  summary.status, summary.integration_status, summary.observed_max_concurrency, summary.team_message_count, summary.team_read_count)
fs.rmSync(workDir, { recursive: true, force: true })