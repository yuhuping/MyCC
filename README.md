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
AgentGraph → 建码 Agent → 审阅 Agent → 优化 Agent → solution / trace
```

离线链路验证：

```bash
node multiagent/smoke-test.mjs
```

运行 MultiAgentBench coding 任务（需要外部任务数据和 Responses API 配置）：

```bash
node multiagent/run-mab.mjs \
  --data /path/to/MARBLE/multiagentbench/coding/coding_main.jsonl \
  --task-ids 1-5 \
  --max-turns 25 \
  --skip-existing
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
