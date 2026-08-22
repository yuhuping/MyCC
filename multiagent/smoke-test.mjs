// 离线冒烟测试：用 demo provider 驱动 2 个 agent 接力，验证编排层链路
// （coordinator + agent-instance + 共享工作区 + message bus），不花任何 API 费用。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runAgent } from '../runtime/agent.mjs'
import { AgentInstance } from '../multiagent/lib/agent-instance.mjs'
import { AgentGraph, runRelayTask } from '../multiagent/lib/coordinator.mjs'

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mab-smoke-'))
const provider = async () => { throw new Error('demo smoke should not call provider') }
// 用 monkey-patch 方式：直接替换 AgentInstance.prototype.run 为 demo 逻辑
const origRun = AgentInstance.prototype.run
AgentInstance.prototype.run = async function ({ task, context }) {
  console.log(`  [demo] agent ${this.agentId} running (context=${context ? 'yes' : 'no'})...`)
  // 模拟 agent 写文件 + 返回结论
  fs.writeFileSync(path.join(this.workspace, 'solution.py'), `# solution by ${this.agentId}\n# task: ${task.slice(0, 40).replace(/\n/g, ' ')}\n`)
  return {
    agentId: this.agentId,
    finalText: `I am ${this.agentId}. I wrote solution.py.${context ? ' Context was: ' + context.slice(0, 60) : ''}`,
    turns: 3,
    diff: '',
    transcript: [],
    termination: 'completed',
    model: 'demo',
  }
}

const graph = AgentGraph.fromConfig([
  { agent_id: 'agent1', profile: 'I create the code from scratch.' },
  { agent_id: 'agent2', profile: 'I review and optimize the code.' },
], [['agent1', 'agent2', 'collaborates with']])

const out = await runRelayTask({ graph, task: 'Write a calculator in solution.py', workspace: ws, provider })
console.log('stages:', out.stages.map(s => `${s.agentId}(${s.kind})`).join(' -> '))
console.log('message bus:', JSON.stringify(out.messageList.map(m => m.kind)))
console.log('finalText:', out.finalText.slice(0, 80))
console.log('solution.py exists:', fs.existsSync(path.join(ws, 'solution.py')))
console.log('solution content:', fs.readFileSync(path.join(ws, 'solution.py'), 'utf8'))
fs.rmSync(ws, { recursive: true, force: true })
console.log('SMOKE OK')