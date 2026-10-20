/**
 * 审批桥端到端：验证「扩展里 await ctx.ui.confirm() → 前端 POST 回填 → 扩展继续跑」。
 *
 * 会在临时目录里造一个扩展，注册一个必须人工确认的工具，然后把 confirm 的请求
 * 转发到 HTTP 接口去答应。整个过程 agent 的 run 不中断，SSE 不断流。
 *
 *   node examples/approval-smoke.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAguiServer } from "../src/server.ts";

const EXTENSION_SOURCE = `/**
 * 冒烟用扩展：注册一个需要人工确认的工具。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "release_switch",
		label: "发布开关",
		description: "Release the feature switch to production. Always requires human approval.",
		parameters: Type.Object({ feature: Type.String({ description: "Feature name to release." }) }),
		// 注意：扩展的 ToolDefinition.execute 签名是 (toolCallId, params, signal, onUpdate, ctx)，
		// ctx 在第五个参数上，不是常见的第三个。
		execute: async (_toolCallId, { feature }, _signal, _onUpdate, ctx) => {
			const approved = await ctx.ui.confirm("发布确认", "要发布 " + feature + " 到生产吗？");
			return { content: [{ type: "text", text: approved ? "已发布：" + feature : "已取消，没有发布" }], details: { approved } };
		},
	});
}
`;

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agui-approval-"));
	await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
	await writeFile(join(cwd, ".pi", "extensions", "approval-probe.ts"), EXTENSION_SOURCE, "utf8");

	const port = 39_500 + Math.floor(Math.random() * 400);
	const { listen, supervisor } = createAguiServer({ port, host: "127.0.0.1", cwd });
	const base = await listen();
	console.log(`服务已起：${base}\n扩展目录：${join(cwd, ".pi", "extensions")}\n`);

	const threadId = randomUUID();
	const response = await fetch(`${base}/`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({
			threadId,
			runId: "approval-run-1",
			messages: [{ id: "m1", role: "user", content: "Please call the release_switch tool with feature='dark_mode'. Do nothing else." }],
			tools: [],
			context: [],
			state: {},
			forwardedProps: {},
		}),
	});

	const decoder = new TextDecoder();
	let buffer = "";
	let answered = 0;
	let sawToolResult = "";
	const seen: string[] = [];

	const reader = response.body!.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let split: number;
		while ((split = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, split);
			buffer = buffer.slice(split + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice(6))
				.join("\n");
			if (!data) continue;
			const event = JSON.parse(data) as any;
			seen.push(event.type);

			if (event.type === "CUSTOM" && event.name === "pi.ui_request") {
				console.log(`收到人工介入请求：${JSON.stringify(event.value)}`);
				const answer = await fetch(`${base}/ui/${event.value.id}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ confirmed: true }),
				});
				console.log(`回填结果：HTTP ${answer.status}`);
				answered += 1;
			}
			if (event.type === "TOOL_CALL_RESULT") {
				sawToolResult += String(event.content);
				console.log(`工具结果：${String(event.content).slice(0, 120)}`);
			}
		}
	}

	console.log(`\n事件序列：${seen.join(" → ")}`);
	assert.ok(answered > 0, "应该出现过至少一次人工确认请求");
	assert.equal(seen[0], "RUN_STARTED");
	assert.equal(seen.at(-1), "RUN_FINISHED", "审批不能打断 run：必须还是同一个 run 正常收尾");
	assert.ok(sawToolResult.includes("已发布"), `工具结果里应该体现审批通过，实际：${sawToolResult.slice(0, 200)}`);

	supervisor.closeAll();
	process.exit(0);
}

main().catch((error) => {
	console.error("审批冒烟失败：", error);
	process.exit(1);
});
