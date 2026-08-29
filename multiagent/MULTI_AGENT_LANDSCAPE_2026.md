# 2026 Multi-Agent 工程版图：从角色接力到真正 Agent Team

> 调研快照：2026-08-28。GitHub star 只作为社区热度代理，不代表系统效果；框架能力以官方文档、官方仓库和论文原文为准。

## 摘要

当前最值得学习的 Multi-Agent 设计，不是让多个角色在一个群聊里轮流说话，而是把并发、上下文隔离、任务状态、结果合并和失败恢复做成明确的运行时协议。工程上已经形成一条相对稳定的主线：**planner/coordinator 动态拆分任务，多个隔离 worker 并行执行，以 artifact 或受控 shared state 交付结果，再由 reducer/integrator/verifier 汇总和验证**。Claude Code Agent Teams 在 coding 产品里最接近“有共享任务表和点对点消息的队友团队”；LangGraph、Google ADK 2.0 和 Microsoft Agent Framework 更适合亲手研究底层编排；OpenAI Agents SDK 适合用最少代码理解 manager、handoff 和程序化并发的差别。CrewAI 易做业务演示，但 hierarchical 不自动等于并行；AutoGen 和 MetaGPT 虽然历史热度高，常见高层范式主要仍是串行 group chat、handoff 或角色流水线。

研究也给出清晰的反面证据：并行可分解任务可能获益，强依赖顺序任务却经常因通信税、状态整合和错误放大而退化。因此，“真正 Agent Team”不应以 Agent 数量或聊天热闹程度判断，而应以是否存在真实执行重叠、独立上下文、可靠任务状态、明确写入所有权和可验证 fan-in 判断。

## 1. 调研问题

- RQ1：2025–2026 的 Multi-Agent 主流协作拓扑是什么，哪些只是在做角色接力？
- RQ2：哪些活跃框架真正支持并发、共享状态/消息和动态任务分配？
- RQ3：对 coding 学习者，哪条实战路线最短，如何验证学到的确实是 Agent Team？

## 2. 方法

检索覆盖五个视角：主流框架官方文档、coding 产品与 demo、生产系统、失败研究与 benchmark、社区热度。技术事实优先采用官方文档/仓库；论文结论以 arXiv、ACL Anthology、Nature Machine Intelligence 或作者项目页核验。纳入 2025–2026 仍有现实学习价值的系统，保留少量经典系统作为反例；排除仅凭二手文章声称“最佳”的排名。

GitHub REST API 快照显示：MetaGPT 约 70.1k stars、AutoGen 60.7k、CrewAI 57.7k、LangGraph 40.6k、OpenAI Agents SDK 29.0k、Google ADK Python 21.3k、Microsoft Agent Framework 13.2k。这里最重要的反常点是：高 star 不等于最新路线；[AutoGen 官方仓库](https://github.com/microsoft/autogen)已经明确进入 maintenance mode，微软建议新项目转向 [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)。

## 3. Taxonomy：先按运行语义分类，不按角色名称分类

| 类型 | 执行语义 | 代表实现 | 是否属于“真并发 Team” |
| --- | --- | --- | --- |
| 串行 role pipeline | A 完成后 B 接手，角色固定 | MetaGPT、ChatDev、MyCC relay | 否；只是多角色工作流 |
| Handoff / GroupChat | 每轮只有一个 active speaker，动态选择下一位 | OpenAI handoff、AutoGen Swarm/Selector/Magentic-One | 通常否；动态但串行 |
| Orchestrator–Workers | coordinator 拆任务，多个 worker 并行，完成后汇总 | Anthropic Research、OpenAI Agents SDK + `asyncio.gather` | 是，但多为父子结构 |
| Fan-out / Fan-in DAG | 图节点并行执行，barrier/reducer 汇总 | LangGraph、Google ADK、Microsoft Agent Framework | 是，最适合学习编排运行时 |
| Shared task board + mailbox | 独立 Agent 认领任务并点对点通信 | Claude Code Agent Teams | 是，最像人类 coding team |
| Event-driven actors | Agent 自有状态，以异步消息/pub-sub 协作，可跨进程 | AutoGen Core | 是，但实现和调试成本最高 |

判断关键是“执行语义”。例如 [AutoGen Swarm](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/swarm.html)虽然允许 Agent 自主 handoff，但官方说明参与者仍轮流生成响应；Magentic-One 也由 orchestrator 每步选一个 worker。因此，动态调度并不自动等于并行。

## 4. 框架对比：流行度之外，更要看并发边界

### 4.1 Claude Code Agent Teams：最接近原生 coding 团队

[官方 Agent Teams 文档](https://code.claude.com/docs/en/agent-teams)给出的运行结构是 lead、多个独立 Claude Code 实例、共享 task list 和 mailbox。每个 teammate 有独立 context window，可以直接给其他 teammate 发消息并自行协调；这与只能把结果返回父 Agent 的普通 subagent 有本质差异。

它适合互相独立的研究、不同模块实现、竞争性 debugging 假设和跨层工作。限制同样明确：功能仍是 experimental；token 成本随活跃 teammate 数量增长；Agent Teams 本身不提供 Git worktree 隔离，因此并行写代码必须先划定文件所有权，同文件修改仍应串行或放入独立 worktree。

### 4.2 LangGraph：最适合学习“团队控制面”

[LangGraph multi-agent 文档](https://docs.langchain.com/oss/python/langchain/multi-agent/index)把 subagents、handoffs、router 和 custom workflow 分开讨论；其中 handoff 主要解决状态/上下文路由，而 router、subagents 和自定义图才适合并行。[Router 教程](https://docs.langchain.com/oss/python/langchain/multi-agent/router-knowledge-base)用 `Send` 将任务动态 fan-out 到多个 Agent，再通过 reducer 收集结果；[custom workflow](https://docs.langchain.com/oss/python/langchain/multi-agent/custom-workflow)允许混合条件、循环和并行节点。

LangGraph 的优势不是“自动产生一个聪明团队”，而是 shared state、reducer、checkpoint、分支重试和可观察执行图都可以显式设计。其代价是 mailbox、任务租约、写入所有权和冲突协议需要自己定义。

### 4.3 Google ADK 2.0：隔离 worker + barrier 的清晰教材

[Google ADK ParallelAgent 文档](https://adk.dev/agents/workflow-agents/parallel-agents/)明确说明多个 sub-agent 的 `run_async()` 同时开始，各自在独立执行分支工作，分支运行中不自动共享对话历史或状态，完成后再收集结果。ADK 2.0 的 [collaborative workflows](https://adk.dev/workflows/collaboration/)进一步区分 chat、task 和可并行的 `single_turn` 协作模式。

这个设计很适合学习一个重要原则：并行 worker 不应实时争写同一消息上下文，而应写不同 `output_key` 或结构化 artifact，最后由 synthesis/integrator 汇总。Google 还提供 Sequential、Parallel、Loop、Graph 和 dynamic workflow，可直接对照“流水线、并行扇出、反馈循环、动态路由”之间的差别。

### 4.4 Microsoft Agent Framework：2026 微软新路线

Microsoft Agent Framework 是 AutoGen 的后继。官方 [Concurrent orchestration](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/concurrent)展示 `ConcurrentBuilder` 将同一输入 fan-out 给多个 participant，再由 aggregator fan-in；[workflow samples](https://github.com/microsoft/agent-framework/tree/main/python/samples/03-workflows)还覆盖 checkpoint、HITL、sub-workflow 和 graph workflow。

它适合同时比较两类机制：`ConcurrentBuilder` 是真实并行，而 Handoff、GroupChat、Magentic 等解决的是动态选择和协作协议，通常仍按轮次推进。新项目不应再从 AutoGen 高层 API 起步；AutoGen 更适合用来学习 actor/event bus 的历史设计。

### 4.5 OpenAI Agents SDK：用最少代码看清 manager、handoff 与并发

[OpenAI Agents SDK orchestration 文档](https://openai.github.io/openai-agents-python/multi_agent/)区分两种高层模式：manager 把 specialists 暴露成 `Agent.as_tool()`，以及把当前对话控制权交给 specialist 的 handoff。handoff 本身不是并行；若任务可以独立拆分，官方建议用 Python 的 `asyncio.gather` 等代码编排并发。官方仓库有可直接运行的 [`parallelization.py`](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/parallelization.py)。

它是最轻的入门实现，但没有现成共享任务板、peer mailbox 或复杂团队调度器。适合先建立正确概念，再进入 LangGraph/ADK/MAF。

### 4.6 CrewAI：易上手，但不要把 hierarchical 当作 concurrent

CrewAI 的角色、任务、Crews 和 Flows 很容易做出可见 demo。[Processes 文档](https://docs.crewai.com/en/concepts/processes)支持 sequential 与 hierarchical；hierarchical manager 会动态规划、委派和验证，但这种委派本身不保证同时执行。真实 overlap 依赖显式 [`async_execution=True`](https://docs.crewai.com/en/concepts/tasks#asynchronous-execution) 的 task，并通过 context 等待结果。

因此 CrewAI 适合快速理解角色、工具、memory、guardrail 和业务工作流，却不是研究 peer-to-peer Agent runtime 的第一选择。

## 5. 研究证据：什么时候 Multi-Agent 反而更差

[Anthropic 的生产 Research 架构](https://www.anthropic.com/engineering/multi-agent-research-system)采用 lead + 并行 subagents：lead 规划并发搜索方向，workers 独立探索，返回压缩结果，lead 再综合。内部 eval 中该配置相对单 Agent 提升 90.2%，但 Anthropic 同时报告 token 使用量是普通 chat 的约 15 倍，并指出 token 用量能解释 BrowseComp 表现差异的大部分方差；这些结果来自内部 research 任务，不能直接外推到 coding。其工程文也明确指出 coding 往往依赖更多共享上下文和顺序执行，并不是天然高并行场景。

2026 年的 [Nature Machine Intelligence 研究](https://www.nature.com/articles/s42256-026-01268-y)在 260 个配置、六个 benchmark、三家模型族和统一 compute budget 下发现：single-agent 基线越强，多 Agent 越可能失去收益；超过三到四个 Agent 后，每个 Agent 可用推理预算下降，token efficiency 也显著变差。论文把能力阈值解释为领域内的实用选择规则，而不是普适定律。

[Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)分析多个 MAS 框架和 150+ 任务，归纳出系统设计、Agent 间失配、验证与终止三大类共 14 种失败；仅加强角色 prompt 或 orchestration 仍不足以消除问题。[Silo-Bench](https://arxiv.org/abs/2603.01045)进一步显示，Agent 即使积极通信并获得了足够分布式信息，也常在状态整合阶段失败，随着 Agent 数量增加，协调开销会吞掉并行收益。

[MultiAgentBench（ACL 2025）](https://aclanthology.org/2025.acl-long.421/)对 star、chain、tree、graph 等拓扑的结果也不支持“graph 永远最好”：graph 只在其 research scenario 中表现最好，cognitive planning 的 milestone 提升为 3%。拓扑收益依赖任务形态，不能从一个 domain 推到所有 coding 任务。

## 6. 对 MyCC 观察的解释

你的观察与当前实现是一致的。MyCC 的默认路径在 [`multiagent/README.md`](./README.md) 中明确写为 `relay`：建码 → 审阅 → 优化，三个 Agent 顺序接力；即使使用 `--coordination dag`，如果没有显式 `--plan`，默认三步 plan 仍等价于 relay。

当前实现其实已有两种真正执行重叠：`parallel-review` 会在 baseline 后并发 reviewer/tester，显式 DAG 能按 ready set 并发并以 worktree/artifact 隔离。它已经是一个可靠的 parallel workflow，但还不是 Claude Code Agent Teams 那种自主团队：拓扑由 coordinator/plan 固定，Agent 没有共享任务认领和 peer mailbox，交付主要通过结构化 artifact，不会自主讨论和重分工。

这个差异不是缺点，而是两个不同研究对象：

- MyCC DAG 适合研究可验证、可复现的并发 workflow；
- Claude Code Agent Teams / 自建 task-board + mailbox 适合研究自治协作协议；
- AutoGen Core 适合研究跨进程 event-driven actor；
- MultiAgentBench coding 数据中的固定角色依赖，不足以单独证明一个 runtime 具备 Agent Team 能力。

## 7. 推荐实战路线

### 第一阶段：两小时内看见“真并发”

1. 跑 [OpenAI Agents SDK parallelization example](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/parallelization.py)，记录每个 worker 的开始/结束时间。
2. 把同一 demo 改成 handoff，观察 active agent 只是发生切换而没有执行重叠。
3. 跑 [Google ADK ParallelAgent 完整示例](https://adk.dev/agents/workflow-agents/parallel-agents/)，让三个 worker 分别写独立 `output_key`，最后由 synthesis Agent 汇总。

### 第二阶段：做一次真的 coding team 实验

在一个带三类独立问题的小仓库中启动四个 Agent：

- planner：只拆 task DAG 和定义 artifact schema；
- investigator-A：复现失败并产出最小 regression test；
- investigator-B：追踪实现路径并提出 patch；
- verifier：挑战假设、跑测试、决定是否集成。

要求 A/B 同时运行，使用独立 worktree；A 的 test artifact 完成后通过 mailbox/blackboard 通知 B 和 verifier；只有 verifier 有 final merge 权限。若两个 worker 同时修改同一文件，调度器应降级为串行或重新切分任务，而不是依赖最后写入者获胜。

### 第三阶段：比较两种“真 Team”

1. 用 [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)完成一次只读 PR review，观察 shared task claim 和 peer messaging。
2. 用 LangGraph `Send` + reducer 重做同一实验，显式实现 task store、mailbox、timeout 和 retry。
3. 在相同模型、工具和总 token budget 下，与 single-agent 对照。

最低指标集：task success/test pass、wall-clock、sum agent time、token、observed max concurrency、重复工作率、merge conflict、错误传播、人工介入次数。只有 `observed_max_concurrency >= 2` 且时间区间确实重叠，才应声称“并行”。

## 8. 视频与课程清单

优先级按“内容真实展示并发/运行时边界”排序：

1. [Foundations of multi-agent systems with ADK](https://www.youtube.com/watch?v=pX0_iIfRilU)：Google Cloud Tech 官方，解释 LLM、Sequential、Parallel、Loop 和 hierarchy，适合先建立分类。
2. [How to build a multi-agent app with ADK and Gemini](https://www.youtube.com/watch?v=LdKBJODIhwc)：Google Cloud Tech 官方，包含 demo、代码走读、状态与 Cloud Run 部署。
3. [Building distributed multi-agent systems](https://www.youtube.com/watch?v=VjBijrS19gY)：Google 官方 ADK + A2A 实战；注意视频里的 Loop/Sequential 部分仍不是并发。
4. [Microsoft Agent Framework introduction](https://www.youtube.com/watch?v=AAgdMhftj8w)：微软官方 30 分钟总览，之后配合 concurrent workflow samples 动手。
5. [Project: Deep Research with LangGraph](https://academy.langchain.com/courses/deep-research-with-langgraph)：LangChain 官方免费课程，约 1.5 小时，后半进入 supervisor 与 multi-agent research system。
6. [Claude Code Agent Teams Explained](https://www.youtube.com/watch?v=1jlKUxqRQAw)：第三方 2026 教程；用来观察真实 team UI、teammate 与监控，技术边界仍以官方文档为准。
7. [Design, Develop, and Deploy Multi-Agent Systems with CrewAI](https://www.deeplearning.ai/courses/design-develop-and-deploy-multi-agent-systems-with-crewai)：DeepLearning.AI 与 CrewAI 联合课程，含自动 code review、deep researcher、Flows、A2A、trace 和部署；课程较长且部分内容需要 PRO。
8. [AI Agentic Design Patterns with AutoGen](https://dev.deeplearning.ai/courses/ai-agentic-design-patterns-with-autogen)：1 小时 26 分钟，适合学 reflection、tool use、planning 与 group chat 的历史范式；不建议把它作为 2026 新项目框架选型依据。

## 9. 结论

- RQ1：主流结构已经从角色群聊转向 coordinator/planner + isolated workers + fan-in verifier；handoff/group chat 多数仍是串行控制流。
- RQ2：Claude Code Agent Teams 最接近原生 coding 团队；LangGraph、Google ADK 2.0、Microsoft Agent Framework 最适合研究真正并发运行时；OpenAI Agents SDK 最适合快速入门。CrewAI 易演示，AutoGen 高层与 MetaGPT 不应因历史热度被误判为最新并发方案。
- RQ3：最短路径是先运行 `asyncio.gather`/`ParallelAgent`，再做 worktree 隔离的 coding fan-out/fan-in，最后实现 shared task board、mailbox、checkpoint 和 verifier，并用相同预算的 single-agent baseline 验证收益。

一句话判断一个 demo：**若不能回答“谁同时在跑、上下文是否隔离、谁维护任务状态、Agent 如何直连通信、并行写入如何隔离、失败后谁合并与重试”，它大概率只是多角色表演，不是真正 Agent Team。**
