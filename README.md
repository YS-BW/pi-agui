# pi-agui

把 [Pi SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) 的 `AgentSession` 接到 [AG-UI](https://github.com/ag-ui-protocol/ag-ui)，让 CopilotKit 或官方 `HttpAgent` 通过 HTTP/SSE 使用 pi 的编码、工具和会话能力。

保留轻量分层：`server.ts` 管 HTTP，`thread.ts` 管 pi 会话与 run，`translate.ts` 翻译事件，`ui-context.ts` 桥接扩展交互。仓库不包含聊天页面。

## 已对齐的版本

2026-10-20 核对并固定 npm 最新发布版本：

| 依赖                                 | 版本     | 用途                             |
| ------------------------------------ | -------- | -------------------------------- |
| `@earendil-works/pi-coding-agent`    | `1.3.0`  | 真实 AgentSession、扩展和持久化  |
| `@ag-ui/core` / `client` / `encoder` | `1.0.3`  | AG-UI 1.0 事件、校验和官方客户端 |
| `@copilotkit/runtime`                | `1.79.1` | 独立 CopilotKit 集成示例         |

参考 [CopilotKit Claude TypeScript 示例](https://github.com/CopilotKit/CopilotKit/tree/main/examples/integrations/claude-sdk-typescript)、[`@ag-ui/claude-agent-sdk` 0.0.7](https://www.npmjs.com/package/@ag-ui/claude-agent-sdk) 和 pi 包自带的 `docs/sdk.md` / TypeScript 声明。pi 和 Claude 的恢复机制不同；本适配器不模拟 Claude 的可序列化调用栈。

## 启动

需要 Node >= 22.19。pi 已作为项目依赖固定安装，不依赖全局软链。

```bash
npm ci --ignore-scripts
# 如尚未配置模型，使用项目内的 pi 登录或选择模型：
npx pi
npm run server
```

默认地址 `http://127.0.0.1:3000`。环境变量：`PORT`、`HOST`、`PI_AGUI_CWD`。使用 pi 的现有模型配置和凭据；不会替你创建 API key。

```ts
import { HttpAgent } from "@ag-ui/client";
const agent = new HttpAgent({
	url: "http://127.0.0.1:3000",
	threadId: "my-thread",
});
agent.addMessage({ id: "u1", role: "user", content: "列出工作目录中的文件" });
await agent.runAgent();
console.log(agent.messages);
```

服务用于受信任的本地环境，没有多用户鉴权或执行沙箱。远程部署需由宿主提供身份、工作区权限与进程隔离。客户端修改 cwd 默认关闭；仅受信任的宿主可设置 `allowClientCwd: true`。

## CopilotKit

见 [`examples/copilotkit`](examples/copilotkit)。集成采用官方示例的链路：

```text
CopilotKit UI → CopilotRuntime v2 → HttpAgent → pi-agui → AgentSession
```

该示例独立安装 Runtime，避免给适配器核心引入整个 CopilotKit 服务端依赖树。

## 工具、状态和人工介入

### 前端工具：标准 pending tool handoff

1. 客户端通过 `RunAgentInput.tools` 提供工具定义；每轮更新参数 schema 和描述。
2. 模型调用后发 `TOOL_CALL_START/ARGS/END`。`TOOL_CALL_END` 表示参数生成完成，不是工具执行结束。
3. pi 的 `finishTurn` 在当前工具批次完成后结束回合，`RUN_FINISHED.outcome` 包含 `{ type: "success", pendingToolCallIds: [...] }`。不会向客户端发送假的工具结果，也不会让模型继续猜结果。混合后端/前端工具批次的后端工具会执行完。
4. 浏览器执行工具，下一次 run 在 `messages` 中提交相应的 `role: "tool"`、`toolCallId` 和真实 `content`。须一次提交全部待处理调用的结果；空字符串也支持，内嵌 data 图片会原样转成 Pi 的图片工具结果。
5. 适配器持久化一条隐藏的 `agui.frontend-results` custom message，以 pi 正常生命周期继续；`context` hook 把原先工具结果中的占位文本替换为真实结果。不会重复提交上一条用户消息。

`Forwarded to client` 只存在于 pi 内部 handoff 记录。前端以 `pendingToolCallIds` 为准。与后端工具同名的前端工具会明确报错，不能覆盖内置工具或扩展工具。

### 共享状态与上下文

`input.state` 初始化当前共享状态；`ag_ui_update_state` 浅合并更新并发 `STATE_SNAPSHOT`。状态工具不会出现在 UI 的工具事件或消息快照中。应用 `context`、输入中的 system/developer 消息与当前状态通过 `before_agent_start` 进入本轮系统提示。

### pi 原生扩展 UI

`ctx.ui.confirm/select/input/editor` 发 `CUSTOM pi.ui_request`，保持 SSE 和原工具 Promise 存活。客户端发送：

```http
POST /ui/<requestId>
Content-Type: application/json

{"confirmed":true}
```

`select/input/editor` 使用 `{ "value": "..." }`，取消使用 `{ "cancelled": true }`。请求按 ID 精确路由；不存在或已完成返回 404。中断会取消等待中的对话框。扩展提供的 timeout / AbortSignal 会生效。

这条原生 UI 旁路不能跨进程重启恢复，且不支持标准 `input.resume`；前端工具 handoff 则可以从 pi 会话记录恢复。`notify/setStatus/setWidget` 为单向事件。

## HTTP 接口

| 方法 | 路径                          | 行为                                                      |
| ---- | ----------------------------- | --------------------------------------------------------- |
| POST | `/`                           | 校验 `RunAgentInput`，返回一个 run 的 SSE；会话忙返回 409 |
| GET  | `/info`                       | 能力与限制                                                |
| GET  | `/threads`                    | 当前进程内已加载会话                                      |
| POST | `/threads`                    | 创建或恢复 `{ threadId?, cwd? }`                          |
| GET  | `/threads/:id/messages`       | 当前已加载会话历史，未知会话返回 404                      |
| POST | `/threads/:id/messages`       | 提交 `{ text, images? }`，返回 202 + runId                |
| GET  | `/threads/:id/events?after=N` | 回放 + 实时 SSE，支持 `Last-Event-ID`                     |
| POST | `/threads/:id/abort`          | 取消当前 run                                              |
| POST | `/ui/:requestId`              | 回填原生扩展 UI                                           |

`threadId` 与 pi `sessionId` 分离，绑定存于 `<agentDir>/agui-bindings`，默认 `~/.pi/agent/agui-bindings`。重启后使用相同 threadId 提交 run 或 POST `/threads` 恢复原会话。自定义 agentDir 时，pi 会话也存于该目录下；一个绑定目录由一个服务进程管理。

客户端断线不会取消后台任务。主 POST 流由标准 HttpAgent 消费；需要断线回放的客户端另外使用 `/events` 的序号。回放只保留进程内最近 2000 条事件，重启不保留事件序号。

## SDK 嵌入

```ts
import { createAguiServer } from "./src/index.ts";
const app = createAguiServer({
	port: 3000,
	cwd: "/path/to/workspace",
	agentDir: "/path/to/pi-config",
	// sessionOptions: { modelRuntime, model, thinkingLevel: "off" },
	// loaderOptions: { extensionFactories: [myExtension] },
});
await app.listen();
// 宿主退出时：
await app.close();
```

`sessionOptions` 和 `loaderOptions` 是宿主控制的配置，不读取客户端 forwardedProps。若想关闭内置工具但保留适配器工具，用 `noTools: "builtin"`；`tools: []` 是 pi 的严格空允许列表，会阻止前端/状态工具并明确报错。

## 验证

```bash
npm test
npm run typecheck
npm ci --prefix examples/copilotkit --ignore-scripts --legacy-peer-deps --omit=optional
npm run test:copilotkit
```

主测试包括原有翻译/状态测试，以及真实 pi SDK + 可控 provider + 官方 HttpAgent 的集成测试，覆盖多轮、前端 handoff、状态更新、并发建会话、并发拒绝、审批路由、错误恢复、abort、断线回放、参数 schema 更新和会话恢复。所有测试不调用付费模型，也不读取用户模型凭据。

保留真实模型冒烟命令（需要自己的模型配置，会调用模型）：

```bash
npm run smoke
npm run smoke:client
npm run smoke:approval
npm run smoke:capabilities
npm run smoke:activity
```

## 范围与限制

- 每个 thread 同时一个 run；没有队列和多进程锁。
- pi 是历史的权威来源。新 thread 不导入客户端提供的整段旧对话；用户回合只提交最后一条 user 消息。
- 支持文本和内嵌 data 图片；远程图片、音频、视频等暂不支持，明确返回错误，不静默丢弃。
- 支持 SSE、全量 state；没有 protobuf、STATE_DELTA 或子 agent 编排。
- 会话池没有 TTL / 容量淘汰；长期、多租户部署需补宿主资源策略。
- 原生 UI Promise 不能跨重启恢复；前端 handoff 可恢复，但不承诺浏览器外部副作用 exactly-once。
- pi 完整消息快照使用 `hist_<index>` ID；客户端按 `MESSAGES_SNAPSHOT` 整体替换。流式 ID 带 runId，避免跨轮碰撞。

MIT
