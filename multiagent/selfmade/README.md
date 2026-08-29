# MyCC 自拟 Lead+并行 Worker Coding 任务集（Lead-Parallel Bench）

不依赖 MultiAgentBench，自拟 **5 个 coding 任务**，用 **「1 个 Lead agent + 2 个并行
Worker + Integrator + Verifier」** 的架构跑多智能体并行协作，并额外实现了
**Worker↔Worker 实时通信信道**。

## 架构（plan: `plans/lead-parallel.json`）

```
lead-design (lead, main)         分解任务、写脚手架 solution.py + modules/__init__.py +
  │                                test_solution.py（含精确函数签名与共享约定），分配文件
  ├── worker-A (patch, isolated)  并行 实现模块 A（只写自己那一个文件）
  └── worker-B (patch, isolated)  并行 实现模块 B（只写自己那一个文件）
       │                           两个 worker 还通过团队信道互相发消息/对齐约定
       ▼
integrate  (integrator, main)    机械 apply 两个 patch + 人工决定 adopt/reject
  │
  ▼
verify     (verifier, read_only) 运行 python3 test_solution.py（失败则触发修复回路）
```

- **并行点**：worker-A / worker-B 属同一 ready set → 编排层并发调度到隔离 worktree
  （`observed_max_concurrency >= 2`），各产出一个 patch，集成节点确定性合并。
- **Lead 角色**：新增 `kind: lead` 节点（main 写者，产出结构化 `lead.json`：
  modules / ownership / acceptance），负责拆解与契约，不替 worker 实现。
- **团队通信**：所有节点额外获得两个工具
  - `postTeamMessage(message, to?)` —— 广播或定向发给队友
  - `getTeamMessages()` —— 读取队友消息（节点开始时上下文也注入快照）
  - 信道跨节点共享（coordinator 级 `teamChannel`），post/read 全量记录到
    trace 与 results.jsonl（`team_messages` / `team_message_count` / `team_read_count`）。

## 5 个任务（`tasks.jsonl`）

| # | 主题 | workerA 模块 | workerB 模块 |
| --- | --- | --- | --- |
| 0 | Text analysis toolkit | modules/textx.py（词/字/行/频率统计） | modules/strutil.py（reverse_words/is_palindrome/acronym） |
| 1 | Grade analyzer | modules/grades.py（avg/median/letter/pass_rate） | modules/report.py（格式化/stdev/histogram） |
| 2 | Mini cache | modules/ttl_cache.py（TTL 缓存） | modules/lru_cache.py（LRU 缓存） |
| 3 | Geometry utils | modules/shapes.py（面积/周长） | modules/geo_math.py（距离/交点/质心） |
| 4 | Mini search engine | modules/indexer.py（倒排索引） | modules/search.py（AND/OR/排序） |

每个任务内容包含：完整函数签名契约、严格文件归属（worker 只碰自己的文件，杜绝并行
patch 冲突）、共享约定（经团队信道对齐）、验收（verifier 运行 `python3 test_solution.py`）。

## 运行

```bash
# 离线集成冒烟（stub provider，不花 API）：验证 lead-DAG + 团队信道 + 集成 + 测试门禁
node multiagent/selfmade/lead-smoke.mjs

# 真实 5 任务运行（LLM）
node multiagent/run-mab.mjs \
  --data multiagent/selfmade/tasks.jsonl --task-ids 0-4 \
  --coordination dag --plan multiagent/selfmade/plans/lead-parallel.json \
  --out multiagent/out/selfmade --max-turns 25 --max-parallel-agents 3 --repair-loops 1
```

## 输出（`multiagent/out/selfmade/`）

- `results.jsonl`：每任务一行，含 coordination_mode=lead-parallel、observed_max_concurrency、
  wall/sum 耗时、integration_status、4 维代码质量 scores、team_message_count 与全部团队消息。
- `work/<task>/`（main 工作区 git 仓库）、`worktrees/<task>/<node>`（worker 隔离 worktree）、
  `artifacts/<task>/<node>`（lead.json / patch.json / patch.diff / integration.json / verification.json）、
  `traces/<task>.trace.json`（完整生命周期 + 团队信道事件）、`sessions/<task>/<node>`。