/**
 * 端到端冒烟：起服务 → 用 AG-UI 的 RunAgentInput 发一句话 → 看 SSE 事件顺序。
 * 需要真实模型（会用 ~/.pi/agent 里的 key），所以不进 npm test。
 *
 *   node examples/smoke.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAguiServer } from "../src/server.ts";

const ENCODER = new TextEncoder();

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agui-smoke-"));
	const port = 39_000 + Math.floor(Math.random() * 500);
	const { listen, supervisor } = createAguiServer({ port, host: "127.0.0.1", cwd });
	const base = await listen();
	console.log(`服务已起：${base}，工作目录：${cwd}\n`);

	const threadId = randomUUID();
	const runId = "smoke-run-1";

	const response = await fetch(`${base}/`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({
			threadId,
			runId,
			messages: [{ id: "m1", role: "user", content: "用一句话回答：1+1 等于几？只回数字和单位，不要别的。" }],
			tools: [],
			context: [],
			state: {},
			forwardedProps: {},
		}),
	});

	console.log(`HTTP ${response.status}  content-type=${response.headers.get("content-type")}\n`);

	const decoder = new TextDecoder();
	let buffer = "";
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
			const event = JSON.parse(data) as { type: string; [key: string]: unknown };
			seen.push(event.type);
			const brief = event.type === "TEXT_MESSAGE_CONTENT" || event.type === "TOOL_CALL_ARGS" ? String(event.delta).slice(0, 60) : "";
			console.log(`${event.type}${brief ? `  «${brief}»` : ""}`);
		}
	}

	console.log(`\n事件序列：${seen.join(" → ")}`);

	assert.equal(seen[0], "RUN_STARTED", "第一个事件必须是 RUN_STARTED");
	assert.ok(seen.includes("TEXT_MESSAGE_START"), "应该有文本消息");
	assert.ok(seen.includes("TEXT_MESSAGE_CONTENT"), "应该有文本增量");
	assert.equal(seen.at(-1), "RUN_FINISHED", "最后一个事件必须是 RUN_FINISHED");

	// 同一个 threadId 再问一次：应该复用同一个 pi 会话（历史累加）
	const second = await fetch(`${base}/threads/${threadId}/messages`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: "刚才我问了什么？一句话回答。" }),
	});
	console.log(`\n第二轮 POST /threads/:id/messages → HTTP ${second.status}`, await second.json());

	// 回放接口是长连接，读一会儿就主动断开
	const controller = new AbortController();
	const replayResponse = await fetch(`${base}/threads/${threadId}/events?after=0`, { signal: controller.signal });
	const replayReader = replayResponse.body!.getReader();
	let replayText = "";
	const replayDeadline = setTimeout(() => controller.abort(), 1500);
	try {
		while (true) {
			const { done, value } = await replayReader.read();
			if (done) break;
			replayText += decoder.decode(value, { stream: true });
		}
	} catch {
		// abort 是预期行为
	}
	clearTimeout(replayDeadline);
	const frames = replayText.split("\n\n").filter((frame) => frame.trim() !== "");
	const sequenced = frames.filter((frame) => frame.startsWith("id: "));
	console.log(`回放接口返回 ${frames.length} 帧，其中 ${sequenced.length} 帧带 id:（可续传）`);

	await new Promise((resolve) => setTimeout(resolve, 100));
	const thread = supervisor.get(threadId);
	console.log(`会话消息数：${thread?.messages().length ?? 0}`);

	supervisor.closeAll();
	process.exit(0);
}

main().catch((error) => {
	console.error("冒烟失败：", error);
	process.exit(1);
});
