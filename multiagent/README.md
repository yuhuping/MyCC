# MyCC Multi-Agent Harness — MultiAgentBench 评测

基于 MyCC（复刻的 Claude Code 内核）构建的多智能体编排框架，用于在
**MultiAgentBench**（官方实现：`ulab-uiuc/MARBLE`，ACL 2025，arXiv:2503.01935）
的 coding 任务域上评测多智能体协作编程能力。

实现遵循仓库根目录 `Audit.md` 的重构设计（显式 DAG + 单一集成者 + worktree 隔离 +
测试门禁 + 可观测 trace），默认行为与历史 relay 基线完全兼容。

## 架构

```
┌────────────────────────────────────────────────────────────────┐
│ 编排层 multiagent/lib/coordinator.mjs                          │
│   runRelayTask  （顺序接力：建码 → 审阅 → 优化，基准，Phase 0 观测）│
│   runPlannedTask（显式 execution plan：ready set 并发、        │
│                   main writer 容量 1、isolated worktree、      │
│                   确定性集成、repair 回路、生命周期 trace）      │
│   MessageBus（审计事件：relay 用 handoff，planned 用             │
│              artifact_ready 可验证引用，绝不传完整 finalText）   │
├────────────────────────────────────────────────────────────────┤
│ 执行层 multiagent/lib/agent-instance.mjs → runtime/agent.mjs   │
│   roleContract 随权限切换（main_writer/read_only/isolated_patch/│
│   integrator/verifier），agent 不持有拓扑与 merge 逻辑          │
├────────────────────────────────────────────────────────────────┤
│ 支撑库                                                        │
│   execution-plan.mjs  plan schema、fail-fast 校验、拓扑/ready set│
│   worktree.mjs        git 命令集中层（异步 spawn、patch、check）│
│   artifacts.mjs       artifact schema、原子写、SHA256、路径越界 │
│   concurrency.mjs     limiter / main-writer mutex / 并发观测     │
│   trace.mjs           append-only lifecycle + 旧 trace 兼容读取 │
├────────────────────────────────────────────────────────────────┤
│ 评测层 multiagent/scorer.mjs（官方 evaluate_code_quality 口径） │
└────────────────────────────────────────────────────────────────┘
```

## 用法

```bash
# 默认 relay（历史基线，格式兼容）—— 3 agent 接力，每 agent 最多 25 轮
node multiagent/run-mab.mjs --task-ids 1 --max-turns 25

# 并发只读审查（Phase 2）：baseline 后 reviewer/tester 并行，不自动 patch/merge
node multiagent/run-mab.mjs --task-ids 1-5 --coordination parallel-review --max-parallel-agents 3

# 真实 DAG：必须带独立 --plan <file>（Audit §4：禁止从文本/relationships 猜拓扑）
node multiagent/run-mab.mjs --task-ids 1-5 --coordination dag --plan plans/coding-dag-v1.json

# 无 --plan 的 dag 模式 = 生成默认三步 plan（等价 relay，可比性保持）
node multiagent/run-mab.mjs --task-ids 1-5 --coordination dag

# 断点续跑 / 仅重评（不重跑 agent，旧 results.jsonl 兼容）
node multiagent/run-mab.mjs --task-ids 1-100 --max-turns 25 --skip-existing
node multiagent/run-mab.mjs --rescore
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--data PATH` | 任务数据（默认 `~/projects/MARBLE/multiagentbench/coding/coding_main.jsonl`） |
| `--out DIR` | 输出目录（默认 `multiagent/out`） |
| `--max-turns N` | 每 agent 轮数上限 |
| `--coordination relay\|parallel-review\|dag` | 协调模式（默认 `relay`） |
| `--plan PATH` | 显式 execution plan JSON（仅 dag 意义下必须显式） |
| `--max-parallel-agents N` | 全局并发上限（覆盖 plan 内上限） |
| `--judge-model M` | 评分 judge 模型 |
| `--skip-existing` / `--rescore` | 断点续跑 / 只重评 |

## Execution plan（落盘 JSON，随 trace 保存）

```json
{
  "version": 1,
  "id": "coding-dag-v1",
  "maxParallelAgents": 3,
  "failFast": true,
  "nodes": [
    { "id": "baseline",    "agentId": "builder",  "kind": "implement",   "dependsOn": [],           "workspaceMode": "main",      "outputs": ["baseline_commit"] },
    { "id": "spec-review", "agentId": "reviewer", "kind": "review",      "dependsOn": ["baseline"], "workspaceMode": "read_only",  "outputs": ["review.json"] },
    { "id": "test-audit",  "agentId": "tester",   "kind": "test_review", "dependsOn": ["baseline"], "workspaceMode": "read_only",  "outputs": ["test-plan.json"] },
    { "id": "integrate",   "agentId": "integrator","kind": "integrate",  "dependsOn": ["spec-review", "test-audit"], "workspaceMode": "main", "outputs": ["integration.json"] },
    { "id": "verify",      "agentId": "verifier", "kind": "verify",      "dependsOn": ["integrate"], "workspaceMode": "read_only", "outputs": ["verification.json"] }
  ]
}
```

校验 fail-fast（provider 调用之前）：重复/未知节点、self-loop/环、`collaborates with`
从不参与 `dependsOn` 计算、同一 ready set 两个 main writer、`maxParallelAgents < 1`、
孤立 patch 无 base 记录、artifact 路径越界/哈希不一致。

## 输出

```
multiagent/out/
  results.jsonl                每任务一行（旧字段不变，追加 coordination_mode /
                                observed_max_concurrency / wall/sum 耗时 / integration_status）
  solutions/<task_id>/solution.py
  traces/<task_id>.trace.json  v2（planned）：plan + nodes + lifecycle + 旧 stages/messages
  work/<task_id>/              main 工作区（git 仓库，仅 main writer/integrator）
  worktrees/<task_id>/<nodeId> 隔离 worker（临时 linked worktree，结束即清理或留痕）
  artifacts/<task_id>/<nodeId> node 结构化交付物（review.json / patch.diff / integration.json …）
  sessions/<task_id>/<nodeId>  agent session
```

顶层指标：`wall_clock_elapsed_ms`（等待时间）与 `sum_agent_elapsed_ms`（近似模型资源）
同时报告；只有 `observed_max_concurrency >= 2` 才能声称并行。main 的任何变更都可通过
base SHA → node → artifact → integration decision → 测试退出码回溯。

## 离线冒烟测试（不花 API 费用，Audit §10 全覆盖）

```bash
npm test             # 即 node multiagent/smoke-test.mjs
```

37 项测试覆盖：plan validator（环/unknown/并行 main writer/…）、并发 1/2/3 与区间重叠
（Phase 2 <260ms 观测）、依赖屏障与 artifact 摘要传递、worktree 生命周期与 cleanup
失败留痕、artifact 原子写/哈希/路径越界/缺失、`git apply --check`/同片段冲突/过期
patch/测试退化、429 重试/超时/AbortSignal 取消、relay 冒烟（Phase 0 timing）、
旧 trace 读取、run-mab 参数与 `--rescore` 兼容。

## 兼容性边界（Audit §11）

- 无 `--plan`/默认参数时 100% 走 `runRelayTask`，与历史分数可比；DAG 实验必须带独立
  `plan_id`/模型/并发上限/基线 commit/结果文件，禁止覆盖或混合旧记录。
- 不做 `Promise.all` 裸并行（会 last-writer-wins）；不做 AutoGen 式 round-robin；
  不翻写既有 `results.jsonl`/trace。

## 结果

以下为历史 **relay 基线**结果（2026-08-17 小样本，`--max-turns 25`，judge=官方
code_quality prompt，模型=deepseek-v4-flash，`coding_main.jsonl` 前 5 题），
不与任何后续 parallel/DAG 实验混写：

| task | agents | turns | 耗时 | instruction | executability | consistency | quality |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 3 | 57 | 6.6min | 4 | 5 | 4 | 3 |
| 2 | 3 | 51 | 5.9min | 2 | 5 | 3 | 4 |
| 3 | 3 | 33 | 5.5min | 3 | 5 | 2 | 4 |
| 4 | 3 | 46 | 5.4min | 2 | 5 | 3 | 4 |
| 5 | 3 | 26 | 3.3min | 5 | 5 | 4 | 5 |
| **平均** | 3 | 42.6 | 5.3min | **3.20** | **5.00** | **3.20** | **4.00** |