# CopilotKit Runtime v2 + pi

参考 CopilotKit 官方 `examples/integrations/claude-sdk-typescript`，将其中的 HTTP agent 地址指向 pi-agui。Runtime 固定为 1.79.1，AG-UI client 为 1.0.3。

先在仓库根目录启动 `npm run server`，然后在你的 Next.js 应用的 `app/api/copilotkit/[[...slug]]/route.ts` 中使用：

```ts
import { CopilotRuntime, InMemoryAgentRunner, createCopilotEndpoint } from "@copilotkit/runtime/v2";
import { HttpAgent } from "@ag-ui/client";
import { handle } from "hono/vercel";

const runtime = new CopilotRuntime({
	agents: {
		default: new HttpAgent({
			url: process.env.PI_AGUI_URL ?? "http://127.0.0.1:3000",
		}),
	},
	runner: new InMemoryAgentRunner(),
});
const app = createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
export const GET = handle(app);
export const POST = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
```

前端沿用官方示例的 CopilotKit provider、聊天组件和前端工具注册方式，指向 `/api/copilotkit`，agent id 为 `default`。pi 扩展的原生 `ctx.ui.confirm` 仍需额外处理 `pi.ui_request` 自定义事件；它不是 CopilotKit 标准前端工具。

## 独立契约测试

从仓库根目录：

```bash
npm ci --ignore-scripts
npm ci --prefix examples/copilotkit --ignore-scripts --legacy-peer-deps --omit=optional
npm run test:copilotkit
```

`runtime.test.mts` 使用真实 `CopilotRuntime`、`InMemoryAgentRunner`、`createCopilotEndpoint`、`HttpAgent` 和 Pi SDK。只有 provider 响应是确定性 fixture，不访问真实模型或用户凭据。测试通过 Runtime 的 HTTP handler 验证前端工具 handoff 与结果续跑，不等同于浏览器 UI 的端到端测试。

使用 `--legacy-peer-deps` 是为了不自动安装 Runtime 兼容的所有可选模型框架；此示例只使用 v2 HTTP agent。宿主 Next.js 项目仍需安装它自身需要的 `hono`、React 和 CopilotKit 前端依赖。
