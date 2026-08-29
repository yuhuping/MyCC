# MyCC

> 一个轻量、可运行的 Claude Code 风格 coding agent，以及基于它构建的多智能体协作 harness。

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/ESM-native-111827?logo=javascript&logoColor=F7DF1E" alt="Native ESM" />
  <img src="https://img.shields.io/badge/Anthropic-API-191919?logo=anthropic&logoColor=white" alt="Anthropic API" />
  <img src="https://img.shields.io/badge/MultiAgentBench-compatible-7C3AED" alt="MultiAgentBench compatible" />
</p>

## ✨ 项目结构

MyCC 的可上传、可运行部分保持在两个目录中：

| 目录 | 作用 |
| --- | --- |
| `runtime/` | Agent loop、SSE 流式请求、工具系统、权限、上下文压缩、会话恢复和终端 TUI |
| `multiagent/` | 多智能体接力编排、共享工作区、Responses API provider 和 MultiAgentBench 入口 |

仓库刻意不包含本地评测数据、评测产物、日志和研究快照；多智能体正式运行时按需从外部提供任务数据。

## 🚀 快速启动 MyCC

环境要求：Node.js `20+`。

```bash
git clone https://github.com/yuhuping/MyCC.git
cd MyCC
cp .env.example .env
```

编辑 `.env`，至少填写 `ANTHROPIC_API_KEY`，然后启动交互式终端：

```bash
npm start -- --tui
```

不调用 API 的本地演示：

```bash
npm start -- --tui --demo
npm start -- --demo --prompt "Inspect this workspace"
```

也可以直接运行离线冒烟测试：

```bash
npm test
```

## 🧠 Runtime 能力

- **Agent loop**：多轮模型响应、工具调用和结果回流
- **工具系统**：`Read`、`Write`、`Edit`、`Glob`、`Grep`、`Bash`、`Agent`
- **可靠性**：超时、瞬时错误重试、部分流恢复、输出 token 扩容
- **上下文管理**：token budget、自动 compact、历史会话持久化与恢复
- **安全边界**：权限规则、headless 模式拒绝未授权工具、hook 生命周期
- **终端体验**：交互式 TUI、`/help`、`/clear`、`/sessions`、`/exit`

核心入口：`runtime/cli.mjs` → `runtime/agent.mjs` → `runtime/tools.mjs`。

## 🤝 Multi-Agent Harness

每个 agent 都复用 `runtime/agent.mjs`，由编排层通过共享工作区和结构化交接消息串联：

```text
relay（默认，历史基准）:   AgentGraph → 建码 Agent → 审阅 Agent → 优化 Agent → solution / trace
planned（显式 DAG）:       execution plan → ready-set 并发 → worktree 隔离
                          → 确定性集成（唯一 main writer）→ 测试门禁 → lifecycle trace
```

实现遵循 `Audit.md`：默认行为与历史 relay 结果格式兼容；并行实验必须带独立
plan/并发上限/结果文件（不覆盖旧记录）。离线链路验证（不花 API 费用）：

```bash
npm test     # node multiagent/smoke-test.mjs（37 项：plan validator / 并发重叠 /
             # 依赖屏障 / worktree / artifact / git apply 冲突 / 429 重试 / 取消 …）
```

### Agent Team（显式启用）

Agent Team 只在传入 `--team` 时启用；lead 与队友复用 `runtime/agent.mjs`，队友在
`.mycc/teams/<team>/` 下的 detached worktree 中运行。模型通过 `TeamCreate`、
`Agent({team_name,name,prompt,run_in_background:true})`、任务/消息工具和
`TeamApplyPatch` 协作：

```bash
node runtime/cli.mjs --team --prompt "并行完成这个修复" --max-teammates 4
```

队友的普通文本不会直接显示给用户，必须用 `SendMessage` 汇报；完成任务后需先
`TaskUpdate(status=completed)`，由 lead 应用 patch 后才能解锁依赖任务。v1 不支持
跨进程恢复、嵌套团队或同一团队的多进程并发写状态。

运行 MultiAgentBench coding 任务（需要外部任务数据和 Responses API 配置）：

```bash
node multiagent/run-mab.mjs \
  --data /path/to/MARBLE/multiagentbench/coding/coding_main.jsonl \
  --task-ids 1-5 \
  --max-turns 25 \
  --skip-existing

# 并发只读审查（baseline 后 reviewer/tester 并行）
node multiagent/run-mab.mjs --task-ids 1-5 --coordination parallel-review --max-parallel-agents 3

# 真实 DAG：显式 --plan（禁止从文本/relationships 猜拓扑）
node multiagent/run-mab.mjs --task-ids 1-5 --coordination dag --plan plans/coding-dag-v1.json
```

更多参数和输出结构见 [`multiagent/README.md`](multiagent/README.md)。`multiagent/out/` 为本地运行产物，默认不会进入 Git。

## ⚙️ 配置示例

`.env` 支持以下常用配置：

```dotenv
ANTHROPIC_API_KEY=your-api-key
MYCC_MODEL=claude-sonnet-4-6
MYCC_API_BASE_URL=https://api.anthropic.com

# Multi-Agent Responses API（可选）
MYCC_RESPONSES_API_KEY=your-responses-api-key
MYCC_RESPONSES_BASE_URL=https://opencode.ai/zen/go
MYCC_RESPONSES_MODEL=deepseek-v4-flash
```

不要把真实密钥提交到 Git；`.env` 已加入忽略规则。

## 📄 License

当前仓库未附带开源许可证。如需公开分发，请先补充与你拥有的代码和依赖相匹配的许可证声明。
