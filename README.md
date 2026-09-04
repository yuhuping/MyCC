# MyCC

> 一个轻量、可运行的 Claude Code 风格 coding agent，以及基于它构建的多智能体协作 harness。但这不是重点，关键在于对 Claude code 的源码理解，本文基于第一性原理为出发点进行分析。

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white" alt="Node.js 20+" />
  <img src="https://img.shields.io/badge/ESM-native-111827?logo=javascript&logoColor=F7DF1E" alt="Native ESM" />
  <img src="https://img.shields.io/badge/Anthropic-API-191919?logo=anthropic&logoColor=white" alt="Anthropic API" />
  <img src="https://img.shields.io/badge/MultiAgentBench-compatible-7C3AED" alt="MultiAgentBench compatible" />
</p>

> 本文皆为个人手敲的文本理解，AI 生成内容会明确标出，如有疏忽之处请见谅。
# 我理解了什么？
- 上下文管理-五层压缩哪些是必须的？thinking 块如何存在？
- 流式工具调用-市场其他 coding 框架也是这样吗？
- Runtime：运行时各式各样的异常如 ctrl-c、定时任务未关闭如何解决
- 多 Agent- 截止 2026.9.01 Claude code 为何还没有正式上线