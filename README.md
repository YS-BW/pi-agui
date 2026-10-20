# pi-agui

把 [pi](https://github.com/badlogic/pi-mono) 的编码 agent 接上 **AG-UI 协议**，让它变成一个可以被前端直接连的 HTTP/SSE 服务。

pi 自带的四种前端是 Interactive / Print / JSON / RPC——都是给终端用的，没有对外的 HTTP 面。这个仓库补的就是那一层：`AgentSession` 换个体位，暴露成标准 AG-UI 事件流。

关键取舍：**pi 是执行内核，AG-UI 是对外契约。** 中间这层只做翻译，不藏业务。换掉 pi 的时候，只有这 900 行要改。

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

只用 12 种事件（协议一共 31 种）：

| pi | AG-UI |
|---|---|
| 请求到来 | `RUN_STARTED` |
| `message_update` / `text_delta` | `TEXT_MESSAGE_START`（首次）+ `TEXT_MESSAGE_CONTENT` |
| `message_update` / `thinking_delta` | `REASONING_START` + `REASONING_MESSAGE_START` + `REASONING_MESSAGE_CONTENT` |
| `message_end` | `TEXT_MESSAGE_END` / `REASONING_MESSAGE_END` |
| `tool_execution_start` | `TOOL_CALL_START`（带 `parentMessageId`）+ `TOOL_CALL_ARGS` |
| `tool_execution_end` | `TOOL_CALL_END` + `TOOL_CALL_RESULT` |
| `turn_start` / `turn_end` | `STEP_STARTED` / `STEP_FINISHED` |
| **`agent_settled`** | **`RUN_FINISHED`** |
| 异常 | `close()` 补齐半截块，然后 `RUN_ERROR` |
| `compaction_*` / `auto_retry_*` / `queue_update` | `CUSTOM pi.compaction` / `pi.retry` / `pi.queue` |

### 三个不能想当然的地方

1. **`RUN_FINISHED` 必须绑 `agent_settled`，不是 `agent_end`。**
   `agent_end` 之后 pi 还可能自动重试、压缩重跑，在那里收尾会让前端提前认为这轮结束。

2. **`TOOL_CALL_START` 的 `parentMessageId` 得自己补。**
   AG-UI 用它把工具调用挂到助手消息上，而 pi 的 `tool_execution_*` 只有 `toolCallId`。
   纯工具轮（助手没吐文本）时补一条空的 `TEXT_MESSAGE_START/END` 当容器。

3. **pi 的消息没有 id。**
   消息 id 由翻译层按 run 内顺序生成，历史消息用 `hist_<下标>`。

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
| 共享 state | `ag_ui_update_state` → `STATE_SNAPSHOT/DELTA` | 无 |
| 前端工具 | 桥接（`input.tools` → 后端可调） | 忽略 `input.tools` |
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
| 忽略 `input.tools` / `input.state` | 前端注册的工具模型看不到 | 把 `input.tools` 转成 `registerTool`，执行时挂起等前端回填 |
| 会话跑在本进程 | 一个会话崩了会影响同进程其他会话 | 换成每会话一个 `pi --mode rpc` 子进程 + 官方 `RpcClient` |

最后一条是刻意留的缝：`Thread` 是唯一持有 `AgentSession` 的地方，换成子进程只需要重写这个类。

## 已验证

- `npm test` — 10 个翻译层单测通过
- `npm run smoke` — `RUN_STARTED → CUSTOM → STEP_STARTED → TEXT_MESSAGE_* → STEP_FINISHED → RUN_FINISHED`，第二轮复用同一会话，回放 34 帧全带 `id:`
- `npm run smoke:client` — 官方 `HttpAgent` 直连，客户端正确攒出 `[user]/[assistant]`
- `npm run smoke:approval` — 扩展 `confirm()` → `CUSTOM pi.ui_request` → `POST /ui/:id` → 工具拿到 `true`
- 用 CopilotKit runtime v2（`CopilotRuntime` + `InMemoryAgentRunner` + `createCopilotEndpoint`）中转，`POST /api/copilotkit/agent/default/run` 返回 200 和完整事件流

## License

MIT
