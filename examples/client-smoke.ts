/**
 * 兼容性验证：用官方 AG-UI 客户端（@ag-ui/client 的 HttpAgent）来连我们的服务。
 * 这一步比手写 fetch 更有意义——它验证的是「前端能不能直接用」。
 *
 *   node examples/client-smoke.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpAgent } from "@ag-ui/client";

import { createAguiServer } from "../src/server.ts";

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agui-client-"));
	const port = 39_900 + Math.floor(Math.random() * 90);
	const { listen, supervisor } = createAguiServer({ port, host: "127.0.0.1", cwd });
	const base = await listen();

	const agent = new HttpAgent({ url: `${base}/`, agentId: "pi", threadId: randomUUID() });

	const seen: string[] = [];
	agent.subscribe({
		onEvent: ({ event }) => {
			seen.push(event.type);
			if (event.type === "RUN_ERROR") console.log("RUN_ERROR:", (event as unknown as { message: string }).message);
		},
	});

	// HttpAgent 只发它自己攒的 this.messages，runAgent() 里传的 messages 会被忽略，
	// 所以要先 setMessages —— 这是客户端的行为，不是服务端的坑。
	agent.setMessages([{ id: "u1", role: "user", content: "只回答两个字：收到" }]);

	await agent.runAgent({
		runId: "client-run-1",
		tools: [],
		context: [],
		forwardedProps: {},
	});

	console.log(`事件数：${seen.length}`);
	console.log(`事件类型：${[...new Set(seen)].join(", ")}`);
	console.log(`客户端累积的消息：`);
	for (const message of agent.messages) {
		const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		console.log(`  [${message.role}] ${text.slice(0, 80)}`);
	}

	assert.ok(seen.includes("RUN_STARTED"), "HttpAgent 应该收到 RUN_STARTED");
	assert.ok(seen.at(-1) === "RUN_FINISHED" || seen.includes("RUN_FINISHED"), "应该收到 RUN_FINISHED");
	assert.ok(agent.messages.some((message) => message.role === "assistant"), "客户端应该攒出一条 assistant 消息");

	console.log("\n✅ 官方 AG-UI 客户端直连成功");
	supervisor.closeAll();
	process.exit(0);
}

main().catch((error) => {
	console.error("客户端冒烟失败：", error);
	process.exit(1);
});
