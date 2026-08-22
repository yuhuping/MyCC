# MyCC Multi-Agent Harness — MultiAgentBench 评测

基于 MyCC（复刻的 Claude Code 内核）构建的多智能体编排框架，用于在
**MultiAgentBench**（官方实现：`ulab-uiuc/MARBLE`，ACL 2025，arXiv:2503.01935）
的 coding 任务域上评测多智能体协作编程能力。

## 架构

```
┌────────────────────────────────────────────────────────────┐
│ 编排层  multiagent/lib/coordinator.mjs  (Node)              │
│   AgentGraph（agent 图谱 + relationships）                  │
│   runRelayTask（顺序接力：建码 → 审阅 → 优化）               │
│   MessageBus（agent 间任务/上下文交接记录）                  │
│   共享工作区（共享文件系统 = 共享内存）                       │
├────────────────────────────────────────────────────────────┤
│ 执行层  multiagent/lib/agent-instance.mjs → runtime/agent.mjs│
│   每个 agent = 一个 MyCC runAgent 实例                       │
│   （自带上下文管理 / 工具系统 / compaction / 子代理）          │
│   模型链路：MyCC Responses provider（deepseek-v4-flash）      │
├────────────────────────────────────────────────────────────┤
│ 评测层  multiagent/scorer.mjs  (Node)                       │
│   复用 MARBLE 官方 evaluate_code_quality 口径                │
│   （4 维度 1-5 分：instruction_following / executability /  │
│     consistency / quality，prompt 原文照搬）                 │
└────────────────────────────────────────────────────────────┘
```

## 用法

```bash
# 跑单个任务（3 agent 接力，每个 agent 最多 25 轮）
node multiagent/run-mab.mjs --task-ids 1 --max-turns 25

# 跑多个任务（区间写法），可断点续跑
node multiagent/run-mab.mjs --task-ids 1-5 --max-turns 20 --skip-existing

# 参数
#   --data PATH        任务数据（默认 ~/projects/MARBLE/multiagentbench/coding/coding_main.jsonl）
#   --out DIR          输出目录（默认 multiagent/out）
#   --max-turns N      每个 agent 的轮数上限
#   --judge-model M    评分 judge 模型（默认 .env MYCC_RESPONSES_MODEL）
```

## 输出

```
multiagent/out/
  results.jsonl                每任务一行：turns/耗时/4 维评分/token usage
  solutions/<task_id>/solution.py   最终交付物
  traces/<task_id>.trace.json  agent 接力全记录（transcript/diff/交接消息）
  work/<task_id>/              共享工作区（git 仓库，可看各 agent 的 diff）
```

## 离线冒烟测试（不花 API 费用）

```bash
node multiagent/smoke-test.mjs   # demo provider 驱动 2 agent 接力，验证编排链路
```

## 结果

小样本（coding_main.jsonl 前 5 题，`--max-turns 25`，judge=官方 code_quality prompt，
模型=deepseek-v4-flash，2026-08-17）：

| task | agents | turns | 耗时 | instruction | executability | consistency | quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | 57 | 6.6min | 4 | 5 | 4 | 3 |
| 2 | 3 | 51 | 5.9min | 2 | 5 | 3 | 4 |
| 3 | 3 | 33 | 5.5min | 3 | 5 | 2 | 4 |
| 4 | 3 | 46 | 5.4min | 2 | 5 | 3 | 4 |
| 5 | 3 | 26 | 3.3min | 5 | 5 | 4 | 5 |
| **平均** | 3 | 42.6 | 5.3min | **3.20** | **5.00** | **3.20** | **4.00** |

- 4 维全局平均 **3.85/5**；`executability`（可编译可运行）5/5 题满分
- 单任务成本约 42 turns（3 agent 接力），judge 额外 ~23k tokens/题