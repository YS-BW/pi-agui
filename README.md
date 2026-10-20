# pi-agui

把 [pi](https://github.com/badlogic/pi-mono) 的编码 agent 接上 **AG-UI 协议**，让它变成一个可以被前端直接连的 HTTP/SSE 服务。

pi 自带的四种前端是 Interactive / Print / JSON / RPC——都是给终端用的，没有对外的 HTTP 面。这个仓库补的就是那一层：`AgentSession` 换个体位，暴露成标准 AG-UI 事件流。

关键取舍：**pi 是执行内核，AG-UI 是对外契约。** 中间这层只做翻译，不藏业务。换掉 pi 的时候，只有这 1800 行要改。

```
前端 (AG-UI client: assistant-ui / CopilotKit / 自写)
      │  POST /   { RunAgentInput }
      │  ←── SSE   { BaseEvent… }
      ▼
src/server.ts      HTTP / SSE / 路由
src/thread.ts      threadId ↔ pi AgentSession，run 生命周期，事件缓冲
src/translate.ts   纯函数：AgentSessionEvent → BaseEvent[]（有单测）
src/ui-context.ts  ExtensionUIContext → CUSTOM 事件 → HTTP 回填
```

## 快速开始

前置：Node ≥ 22.18，以及全局装好的 pi。

```bash
npm i -g @earendil-works/pi-coding-agent
npm install          # postinstall 会把全局 pi 软链进 node_modules
npm run server       # 127.0.0.1:3000，cwd = 当前目录
```

前端侧：

```ts
import { HttpAgent } from "@ag-ui/client";

const agent = new HttpAgent({ url: "http://127.0.0.1:3000/" });
```

环境变量：`PORT`（默认 3000）、`HOST`（默认 127.0.0.1）、`PI_AGUI_CWD`（agent 的工作目录）。

### 验证

```bash
npm test              # 翻译层单测，10 个，不碰网络和模型
npm run typecheck
npm run smoke         # 真实模型跑一轮，看事件顺序
npm run smoke:client  # 用官方 @ag-ui/client 的 HttpAgent 连
npm run smoke:approval # 扩展里的 ctx.ui.confirm() 被前端回填
```

三个 smoke 会真实调用模型，所以不进 `npm test`。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/` | **AG-UI 主入口**，收 `RunAgentInput`，回 SSE |
| `GET` | `/info` | 能力描述，前端据此降级 |
| `GET` | `/threads` | 列进程内会话 |
| `POST` | `/threads` | 预建会话 `{ cwd?, threadId? }` |
| `GET` | `/threads/:id/messages` | 历史消息（AG-UI `Message[]`） |
| `POST` | `/threads/:id/messages` | 塞消息，`202 + runId`，忙时 `409` |
| `GET` | `/threads/:id/events?after=N` | SSE 回放 + 实时，支持 `Last-Event-ID` |
| `POST` | `/threads/:id/abort` | 中断当前 run |
| `POST` | `/ui/:requestId` | 回填扩展的人工确认 |

`threadId`（AG-UI 侧，前端给）和 `sessionId`（pi 侧，pi 生成）是两个 id。`RUN_STARTED` 之后紧跟一条 `CUSTOM pi.thread` 把后者告诉前端，方便它做会话列表。

## 事件映射

31 种事件里用了 24 种。没用的是 3 个 `*_CHUNK`（pi 本身就是流式 delta，再用 CHUNK 只能憋到 `message_end` 一次性发，等于关掉流式）、`RAW`（pi 不暴露 provider 原始事件）、`SUBAGENT_*`（pi 没有子 agent 概念）。

| pi | AG-UI |
|---|---|
| 请求到来 | `RUN_STARTED` |
| `message_update` / `text_start`+`text_delta`+`text_end` | `TEXT_MESSAGE_START`（首次）+ `TEXT_MESSAGE_CONTENT` |
| `message_update` / `thinking_start`+`thinking_delta`+`thinking_end` | `REASONING_START` + `REASONING_MESSAGE_START` + `REASONING_MESSAGE_CONTENT` + `REASONING_MESSAGE_END` + `REASONING_END` |
| `AssistantMessage.content[].thinkingSignature` | `REASONING_ENCRYPTED_VALUE`（`message_end` 时补发） |
| `message_update` / `toolcall_start`+`toolcall_delta` | `TOOL_CALL_START`（带 `parentMessageId`）+ 逐段 `TOOL_CALL_ARGS` |
| `toolCall.thoughtSignature` | `REASONING_ENCRYPTED_VALUE`（`subtype: "tool-call"`，`entityId` = `toolCallId`） |
| `tool_execution_start` | 兜底：只有没流式发过时才补 `TOOL_CALL_START` + `TOOL_CALL_ARGS` |
| `tool_execution_update` | `ACTIVITY_SNAPSHOT`（`activityType: "tool.progress"`，replace 语义） |
| `tool_execution_end` | `TOOL_CALL_END` + `TOOL_CALL_RESULT`（出错带 `metadata.isError`）+ 收尾活动块（带 `durationMs`） |
| `bash_execution_update` | 首片 `ACTIVITY_SNAPSHOT`，之后 `ACTIVITY_DELTA`（RFC 6902 `add /chunks/-`） |
| `turn_start` / `turn_end` | `STEP_STARTED` / `STEP_FINISHED` |
| **`agent_settled`** | **`RUN_FINISHED`**，带 `usage`；`aborted` 时 `outcome: {"type":"cancelled"}` |
| `AssistantMessage.usage` | `RUN_FINISHED.usage`（`TokenUsage[]`，按 provider/model 分桶累计） |
| 异常 | `close()` 补齐半截块，然后 `RUN_ERROR`（也带 `usage`） |
| `compaction_*` | `CUSTOM pi.compaction`（成功压缩后追加 `MESSAGES_SNAPSHOT`） |
| `auto_retry_*` / `summarization_retry_*` | `CUSTOM pi.retry` / `pi.retry_end` / `pi.summarization_retry` |
| `queue_update` / `session_info_changed` / `thinking_level_changed` | `CUSTOM pi.queue` / `pi.session_info` / `pi.thinking_level` |
| `ag_ui_update_state` 工具 | `STATE_SNAPSHOT`（工具本身不进事件流） |
| 每个 run 收尾 / 压缩后 | `MESSAGES_SNAPSHOT` |
| 扩展 `ctx.ui.setWidget` | `ACTIVITY_SNAPSHOT`（`activityType` 由 widget key 决定） |

### 六个不能想当然的地方

1. **`RUN_FINISHED` 必须绑 `agent_settled`，不是 `agent_end`。**
   `agent_end` 之后 pi 还可能自动重试、压缩重跑，在那里收尾会让前端提前认为这轮结束。

2. **`TOOL_CALL_START` 的 `parentMessageId` 得自己补。**
   AG-UI 用它把工具调用挂到助手消息上，而 pi 的 `tool_execution_*` 只有 `toolCallId`。
   纯工具轮（助手没吐文本）时补一条空的 `TEXT_MESSAGE_START/END` 当容器。
   工具调用本身也是流式的（`toolcall_start/delta`），要在这里就发，等 `tool_execution_start`
   才发的话参数已经全了，前端看不到渐进——用 `streamedToolCalls` 去重。

3. **推理块必须在 `thinking_start` 就开，不能在第一个 `thinking_delta` 才开。**
   redacted thinking 在 `thinking_start` 时内容就已完整、之后不再有 delta，
   等 delta 会永远开不出块，签名也就挂不上。

4. **`text_end` 要按「已发字符数」补差值。**
   有些 provider 不吐 delta，只在 `text_end` 给全文；只信 delta 会丢文本，无脑重发又会重复。

5. **`tool_execution_update` 是「累积快照」不是「增量」。**
   pi 的 bash 工具用 `OutputAccumulator.snapshot()` 推送，还带 200ms 节流，
   所以这里只能发 `ACTIVITY_SNAPSHOT{replace:true}`；真正增量的是 `bash_execution_update`（`!` 命令通道），那个才用 `ACTIVITY_DELTA`。

6. **pi 的消息没有 id。**
   消息 id 由翻译层按 run 内顺序生成，历史消息用 `hist_<下标>`。
   `MESSAGES_SNAPSHOT` 的语义是「整段替换」，所以两套 id 不必一致。

## 人工介入

AG-UI 的标准做法是 interrupt：`RUN_FINISHED{outcome:"interrupt"}` 关流，下一次 run 带 `resume` 恢复。**这里没采用**——pi 的工具是卡在 `await` 里等答案的，杀 run 就丢了上下文和调用栈，而 pi 也没有 Claude Agent SDK 那样的 `resume` 语义。

实际走 `CUSTOM` 旁路，**SSE 不断流**：

```
扩展: await ctx.ui.confirm("发布确认", "要发布吗？")
   │
   ├─ ui-context.ts 生成 requestId，挂起 Promise
   ├─ SSE: CUSTOM { name:"pi.ui_request", value:{ id, method:"confirm", title, message } }
   │
前端: POST /ui/<id>  { "confirmed": true }
   │
   ├─ Promise resolve(true)
   └─ 工具继续执行，run 正常收尾
```

`ctx.ui` 上可用的：`select` / `confirm` / `input` / `editor`（等回填），
`notify` / `setStatus` / `setWidget`（单向通知）。其余 TUI 专属方法吞掉。

> 踩过的坑：扩展里 `ToolDefinition.execute` 的签名是
> `(toolCallId, params, signal, onUpdate, ctx)`，**`ctx` 在第五个参数**，不是第三个。

## 和官方 `@ag-ui/claude-agent-sdk` 的对照

那个包 1852 行，覆盖的东西和我这 900 行大量重叠——连「同一 thread 只允许一个活跃 run」的 guard 都是一模一样的逻辑。差别主要在两端：

| | claude adapter | 这里 |
|---|---|---|
| 会话映射 | `sessions` / `bindings` / `activeQueries` 三张表 | `Thread` + `ThreadSupervisor` |
| 容量 | TTL 30min + 上限 1000，主动淘汰 | 无，进程内常驻 |
| 审批 | **标准 interrupt + `input.resume`** | CUSTOM 旁路 |
| 共享 state | `ag_ui_update_state` → `STATE_SNAPSHOT/DELTA` | `ag_ui_update_state` → `STATE_SNAPSHOT` |
| 前端工具 | 桥接（`input.tools` → 后端可调，回占位符） | 同左，且在 run 之间动态增删 |
| 推理签名 | `REASONING_ENCRYPTED_VALUE` | 同左 |
| 活动块 | 无 | `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` |
| token 用量 | 无 | `RUN_FINISHED.usage` / `RUN_ERROR.usage` |
| 中断语义 | `RUN_FINISHED{outcome:"interrupt"}` | `RUN_FINISHED{outcome:"cancelled"}` |
| 断线续传 | 无，`end()` 就完 | ring buffer 2000 条 + `Last-Event-ID` + 心跳 |
| 会话列表/历史/abort | 无 HTTP 面 | `/threads` 系列 |
| 结构 | `extends AbstractAgent`，Observable | 手写，翻译层是纯函数，可单测 |

**为什么审批那条我没抄：** Claude Agent SDK 能 `canUseTool` 停掉 query、下次用 session UUID `resume`；pi 的工具执行没有可序列化的中断点。这是内核差别，不是适配层能抹平的。

**为什么我多了断线回放：** CopilotKit 的 runtime 自己有内存 store（`InMemoryAgentRunner.connect()` 会 replay 缓存），所以接 CopilotKit 时这条是冗余的；但直连场景（assistant-ui、自写前端）没有 runtime 兜底，得我自己留。

## 局限

| 局限 | 现状 | 解决方向 |
|---|---|---|
| 一个会话同时只能跑一个 run | 并发直接 `RUN_ERROR` | 用 pi 的 `steer` / `followUp` 排队，AG-UI 的 run 语义要自己定义 |
| `threadId` 映射只在内存 | 进程重启后老 threadId 会新开会话 | 存一张 `aguiThreadId → piSessionId` 表 |
| 只支持 SSE | `EventEncoder` 固定 `text/event-stream` | 按 `accept` 选 protobuf，改动很小 |
| 事件缓冲上限 2000 条 | 长时间断线会丢早期事件 | 落盘，或用 `MESSAGES_SNAPSHOT` 兜底 |
| 前端工具不能在 run 之间改名 | 名字变了要重新注册，旧名字不会从 pi 的登记表里删 | 目前够用；真要清，得重开 session |
| `STATE_DELTA` 没实现 | 只发 `STATE_SNAPSHOT`（全量） | 加 RFC 6902 patch，但前端兼容性未知，全量更稳 |
| `SUBAGENT_*` 没实现 | pi 没有子 agent 概念 | 用 `createAgentSession` 起子会话 + `parentToolCallId` 关联，属从零搭 |
| 会话跑在本进程 | 一个会话崩了会影响同进程其他会话 | 换成每会话一个 `pi --mode rpc` 子进程 + 官方 `RpcClient` |

最后一条是刻意留的缝：`Thread` 是唯一持有 `AgentSession` 的地方，换成子进程只需要重写这个类。

## 已验证

- `npm test` — 29 个翻译层 / 状态层单测通过
- `npm run smoke` — `RUN_STARTED → CUSTOM → STEP_STARTED → TEXT_MESSAGE_* → STEP_FINISHED → RUN_FINISHED`，第二轮复用同一会话，回放 34 帧全带 `id:`
- `npm run smoke:client` — 官方 `HttpAgent` 直连，客户端正确攒出 `[user]/[assistant]`
- `npm run smoke:approval` — 扩展 `confirm()` → `CUSTOM pi.ui_request` → `POST /ui/:id` → 工具拿到 `true`
- `npm run smoke:capabilities` — 真实模型跑通前端工具桥（回 `Forwarded to client`）、`STATE_SNAPSHOT`、`MESSAGES_SNAPSHOT`、`RUN_FINISHED.usage`
- `npm run smoke:activity` — 真实模型跑 3 秒的 bash 循环，收到 14 帧 `ACTIVITY_SNAPSHOT`（累积增长，收尾带 `durationMs: 3332`）
- 用 CopilotKit runtime v2（`CopilotRuntime` + `InMemoryAgentRunner` + `createCopilotEndpoint`）中转，`POST /api/copilotkit/agent/default/run` 返回 200 和完整事件流

## License

MIT
