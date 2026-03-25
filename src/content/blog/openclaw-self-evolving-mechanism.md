---
title: "OpenClaw 的自进化：不更新权重，如何让 Agent 持续变聪明"
description: "深入源码拆解 OpenClaw 基于外部记忆状态的 inference-time evolution 机制：记忆层、两条写回路径、技能系统与 Heartbeat 的真实边界"
date: 2026-03-20
tags: ["AI Agent", "OpenClaw", "自进化", "Agent 架构"]
---

OpenClaw 不训练自己。它的模型权重从第一次运行到第一千次运行，没有发生任何变化。但它的设计意图很明确：让第一千次运行能利用前九百九十九次积累的经验。

这套机制是否真的让 agent "变好了"，取决于记忆质量和检索命中率——但从工程实现看，积累和复用的通路确实已经打通。OpenClaw 实现了一套 inference-time evolution 方案：进化发生在外部记忆状态上，而不是模型参数里。我们深入源码后发现，这套机制比表面看起来更精巧，但也比某些描述更克制。

## 先定义"自进化"

本文所说的"自进化"指：agent 在运行中持续积累经验、更新规则、扩展行为模板，并在后续任务中复用这些结果。进化不仅可以发生在模型权重里，也可以发生在外部记忆状态上。OpenClaw 没有更新模型权重的能力，但具备更新外部记忆状态的能力——它属于后者，通过记忆层实现 agent 自进化。

这意味着 OpenClaw 更接近一个经验丰富的工程师：不是变得更聪明，而是笔记越来越多、检索越来越快。

具体来说，OpenClaw 的自进化回路是：

**外部状态积累 → prompt / tool 注入 → 后续运行复用 → 行为持续调整**

新信息写入工作区记忆文件。旧信息在后续会话中被语义检索出来。系统在用户无感知的情况下触发后台整理。记忆落在 Markdown 文件中，人类可以直接阅读和修改。

## 记忆层：进化实际发生的地方

OpenClaw 的长期演化不依赖模型"脑内记忆"，而依赖外部持久化文件。这是一个刻意的设计选择。

记忆的事实源是工作区里的 plain Markdown，主要有两层：

- **`MEMORY.md`**：长期、整理过的常青记忆。代码实现上，除 subagent 和 cron（minimal mode）外的所有会话——包括群聊——都会注入此文件。值得注意的是，`docs/concepts/memory.md` 声称 MEMORY.md 仅在 main/private session 加载、"never in group contexts"，但代码中没有实现这一过滤（`filterBootstrapFilesForSession()` 只检查 subagent/cron，不检查群聊类型）。这是一个文档与实现的不一致。
- **`memory/YYYY-MM-DD.md`**：追加式 daily log，作为按需检索的时序记忆来源。

这两层对应两条不同的注入路径。`MEMORY.md` 属于 bootstrap 文件，和 `AGENTS.md`、`SOUL.md` 等一起在每轮注入到 system prompt 的 Project Context 中——代码实现上，除 subagent 和 cron 外 agent 都能看到它（包括群聊，尽管文档声称不应如此）。`memory/*.md` 则不会自动注入，它们只在需要时通过 `memory_search` 和 `memory_get` 两个工具按需检索。

`memory_search` 的设计值得注意。它的工具说明本身就把"先回忆再回答"编码进了语义：当问题涉及 prior work、decisions、preferences 等内容时，模型应优先做语义检索。这不是用户每次都要提醒模型翻记忆——回忆流程被编进了默认 system prompt 与 tool 设计中。

检索的底层实现支持 SQLite / FTS / 向量检索组合，也支持可选的 QMD 后端。但无论底层索引如何变化，系统对模型暴露的接口都稳定为 `memory_search` / `memory_get`。存储实现和模型行为被干净地隔离开了。

OpenClaw 还支持时间衰减（temporal decay），但默认关闭（`enabled: false`，`halfLifeDays: 30`）。按日期命名的时序文件可参与衰减，`MEMORY.md` 这类常青文件不参与。这给"近期事件"和"长期知识"保留了不同的语义通道。

## 两条写回路径：抢救与归档

OpenClaw 不是只能读记忆。它已经实现了两条写回路径，只是写回方式有明确边界。

### Pre-compaction memory flush

当会话接近 auto-compaction 时，OpenClaw 触发一次对用户不可见的 agentic turn（通过 prompt 指令引导模型输出 `NO_REPLY` token，再由 `isSilentReplyText()` 在输出层抑制）。目的很直接：在上下文被压缩前，先把值得保留的内容写入记忆。

实现链路经过 `runMemoryFlushIfNeeded()` 判断阈值，启动一次带 `trigger: "memory"` 的隐藏运行，写入目标被限制为当天的 `memory/YYYY-MM-DD.md`，且只允许 append。这是一种受限写入——agent 有主动写记忆的能力，但不能无限制地改任何文件。

### Session-memory hook

`session-memory` 是内置的会话归档 hook。用户执行 `/new` 或 `/reset` 时触发，从当前会话对应的 session 文件中读取最近 N 条消息（默认 15，若主文件为空则回退到最近的 `.reset.*` 归档文件），调用一次 LLM（使用当前 agent 配置的主模型）生成文件名 slug（如 `vendor-pitch`、`api-design`），然后通过 `writeFileWithinRoot` 直接写入 `memory/YYYY-MM-DD-slug.md`。

这里有一个关键区别：session-memory hook 的写入由 Node.js 文件操作直接完成，不是 agent turn，不受 append-only 限制，每次触发写入一个以日期和 slug 命名的文件。需要注意，如果同日期生成了相同的 slug，新内容会覆盖已有文件——代码中没有碰撞检测或计数器机制。

两种机制的对比：

|          | session-memory hook     | pre-compaction flush           |
| -------- | ----------------------- | ------------------------------ |
| 触发条件 | 用户 `/new` 或 `/reset` | context 接近 token 上限        |
| 执行方式 | Node.js 直接文件写入    | 受限 agent turn（append-only） |
| 写入内容 | 原始对话节选            | agent 筛选后的值得保留内容     |
| 写入粒度 | 按日期+slug 写入（同名覆盖） | 追加到当天 daily memory        |

两者共同覆盖"会话结束归档"和"上下文压缩前抢救"两个场景。

## 常见误解：Skills 和 Heartbeat 在自进化中的角色

我们在分析过程中发现，两个模块经常被误认为自进化的核心组成部分。实际情况比这更细微。

**技能系统**改变的是"能做什么"和"如何做"，但当前设计中 agent 实际上不会自主修改技能。这里需要区分"硬性权限阻止"和"路径设计未引导"。

在自动写回路径（memory flush run）中，工具白名单仅允许 read/write，且 write 被限制为 append-only 到指定的 daily memory 文件——flush run 无法创建或修改 `SKILL.md`。但这不是一个显式的技能写保护，而是 memory flush 路径限制的副作用。在普通 agent turn 中，filesystem policy 并不会专门阻止写 `SKILL.md`（`workspaceOnly` 默认关闭，且 `SKILL.md` 位于 workspace 内）。agent 不写 `SKILL.md`，更多是因为系统 prompt 没有引导它这么做，而非硬性权限拦截。

实际的技能更新链路仍然是：agent 在 memory 中记录建议 → 人类读到后手动创建 `SKILL.md` → `chokidar` 检测到变化并热加载 → agent 下一轮获得新技能。进化闭环断在第二步。Skills 提供的是运维层的热加载能力，当前并未被纳入 agent 的自主进化回路。

**Heartbeat** 是通用的 agent 唤醒系统，负责响应 cron、消息、exec 等外部事件。代码中有一行明确的证据：

```typescript
const canAttemptFlush = memoryFlushWritable && !params.isHeartbeat && !isCli;
```

`isHeartbeat: true` 时，`canAttemptFlush` 恒为 `false`。Heartbeat 运行期间，pre-compaction memory flush 被显式阻断，这意味着 Heartbeat 不会触发自动记忆沉淀。但需要注意，Heartbeat 唤醒后的 agent turn 仍可使用常规工具——它被排除的是 flush 路径，而非所有写入能力。

Skills 不参与进化，但这恰恰也蕴藏着研究和贡献机会，如果 Agent 能可控的根据经验创建-更新-删除skills，那是不是 Agent 的 skills 越用越强？越用越准？

## 真实的边界

诚实地说，OpenClaw 的自进化能力有明确的边界。

**自动沉淀主要落在日志化记忆。** 当前写回机制最稳定的落点是 `memory/YYYY-MM-DD.md` 和 `memory/YYYY-MM-DD-<slug>.md`。这保证了经验不丢，但系统不会自动把所有内容整理成高质量、去重后的知识库。"先保住经验"已经实现，"把经验系统化整理成长期知识"仍然更多依赖后续工作流。

**会话日志是潜在知识源，不是默认记忆层。** 会话 transcript 会落盘到 `sessions/*.jsonl`，但不是默认总会被 `memory_search` 使用。配置帮助明确建议默认保持 `["memory"]`，只有确实需要回忆旧对话时再把 `"sessions"` 加进来。

**写入受工具权限约束。** workspace 是否可写、flush run 的工具白名单、append-only 限制——这些约束是故意设计的，目的是在"能积累经验"和"避免失控漂移"之间保持平衡。

## 我们从中学到的三件事

OpenClaw 的自进化方案揭示了一个实用的工程范式：当你无法改变模型本身时，改变模型能看到的东西。

进化不必发生在权重里。把经验外置到可检索的文件中，把回忆流程编码进工具语义，把沉淀触发器嵌入系统 hook——这些加在一起，就构成了一个 inference-time 的进化回路。它的能力上限仍受底层模型限制，但它的知识边界可以持续扩展。

可控性和进化能力不矛盾。OpenClaw 对写入路径的层层限制——append-only、受限目标文件、Heartbeat 期间阻断 flush——不是进化能力的削弱，而是让进化可审计、可人工干预的前提。一个不可控的自进化系统不是更强大的系统，而是一个更危险的系统。

最有效的自进化往往最朴素。没有复杂的元学习算法，没有自动生成的训练数据，没有模型蒸馏。只有 Markdown 文件、语义检索、和两个写回 hook。这套机制之所以有效，恰恰是因为它足够简单，简单到每一步都可以被人类理解和干预。
