/**
 * 服务入口：把 pi 会话挂到 AG-UI 协议上对外提供。
 *
 *   npm run server        # 默认 127.0.0.1:3000
 *   PORT=8080 PI_AGUI_CWD=~/work npm run server
 *
 * 前端用 @ag-ui/client 的 HttpAgent 指到 http://127.0.0.1:3000 即可。
 */

import { createAguiServer } from "../src/server.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const cwd = process.env.PI_AGUI_CWD ?? process.cwd();

const { listen } = createAguiServer({ port, host, cwd });
const url = await listen();

console.log(`AG-UI 服务已启动：${url}`);
console.log(`工作目录：${cwd}`);
console.log(`AG-UI run 入口：POST ${url}/`);
