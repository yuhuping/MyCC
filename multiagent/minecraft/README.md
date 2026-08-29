# MyCC Multi-Agent Harness — MultiAgentBench Minecraft 场景评测

基于 MyCC 多智能体 harness 的 **Minecraft（建房）** 场景评测，
与 coding 场景共用同一 LLM provider（`multiagent/lib/responses-provider.mjs`）。

与官方（真 Minecraft server + mineflayer bot）的差异：本实现为 **headless 模拟器**
（`sim.mjs`），世界状态转移、物理规则（方块不能悬空、occupied 拒绝）、**11 个官方工具**
（`minecraft_env.py` 注册集）与**官方评分口径**（`build_judger.cal_block_hit_rate`，坐标+名字+
facing 匹配）一致，仅省略“寻路/挖掘动画”等真实感环节。

## 任务数据

`~/projects/MARBLE/multiagentbench/minecraft/minecraft_main.jsonl`（官方发布 = GitHub
`ulab-uiuc/MARBLE` 同一文件，md5 一致）。100 条记录，均为同构 3 块蓝本：
`cut_sandstone(-8,-60,0) → terracotta(-8,-59,0) → torch(-8,-58,0)`（y=-61 为地面），
3 个角色（agent1 取材放置 / agent2 设计顺序与辅助 / agent3 辅助块），`coordinate_mode: graph`。

## 用法

```bash
# 离线冒烟（不花 API 费用）
node multiagent/minecraft/smoke-test.mjs

# 单 agent 全包
node multiagent/minecraft/run-mc.mjs --task-ids 0-3 --agents 1 --mode serial --out multiagent/out/minecraft/solo

# 三角色串行（每轮 agent1→agent2→agent3 顺序调度，并发=1）
node multiagent/minecraft/run-mc.mjs --task-ids 0-3 --agents 3 --mode serial --out multiagent/out/minecraft/trio-serial

# 三角色并行（每轮对活跃 agent 并发发起模型调用，world 变更由同步语义保证原子）
node multiagent/minecraft/run-mc.mjs --task-ids 0-3 --agents 3 --mode parallel --out multiagent/out/minecraft/trio-parallel

# 组合报告
node multiagent/minecraft/report-merge.mjs multiagent/out/minecraft > multiagent/out/minecraft/REPORT.md
```

参数：`--data`（默认官方路径）、`--task-ids 0-3`、`--agents 1|3`、`--mode serial|parallel`、
`--max-rounds`（每 agent 模型调用上限，默认 6）、`--max-tool-calls`（单次调用内工具执行上限，默认 14）、
`--max-tokens`、`--model`、`--skip-existing`（跳过 results.jsonl 已有记录）。

## 输出

`<out>/results.jsonl` 每任务一行：task_id / agents / mode / rounds / wall_clock_elapsed_ms /
sum_agent_elapsed_ms / observed_max_concurrency / block_hit_rate / precision / placed_non_aux /
aux_remaining / per_agent(hits,placed,模型调用数,工具数,tokens) / round_records。

只在 `observed_max_concurrency >= 2` 时才能声称并行（parallel 模式每轮对活跃 agent 并发发起调用）。

## 与 coding 场景的对比（设计意图）

- coding（`run-mab.mjs`）：写代码任务，角色间天然串行依赖，并行体现在“评审/测试”等
  只读子任务的并发扇出；评分是代码质量 4 维。
- minecraft（`run-mc.mjs`）：建房任务，多 agent 可**同时在世界里放不同方块**（共享状态
  变更需原子），评分是官方 block_hit_rate。适合观察并行调度下的共享状态冲突与吞吐。