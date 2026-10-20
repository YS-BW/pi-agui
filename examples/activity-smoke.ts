/**
 * 活动块冒烟：让**真实 pi agent** 跑一条会持续吐输出的 bash 命令，
 * 验证 `tool_execution_update` 真的被翻成 ACTIVITY_SNAPSHOT 送到前端。
 *
 * 为什么值得单独测：pi 的 bash 工具对 onUpdate 做了节流（约每 200ms 一次），
 * 并且推的是「到目前为止的完整输出快照」，不是增量。所以这里断言的是
 * replace 语义 + 最终块带 durationMs，不是 patch。
 *
 * 跑法：node examples/activity-smoke.ts
 */

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAguiServer } from "../src/server.ts";

const decoder = new TextDecoder();

interface Frame {
	type: string;
	[key: string]: unknown;
}

async function runOnce(base: string, body: unknown): Promise<Frame[]> {
	const response = await fetch(`${base}/`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	const frames: Frame[] = [];
	let buffer = "";
	const reader = response.body!.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let split: number;
		while ((split = buffer.indexOf("\n\n")) !== -1) {
			const frame = buffer.slice(0, split).trim();
			buffer = buffer.slice(split + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => line.slice(6))
				.join("\n");
			if (!data) continue;
			frames.push(JSON.parse(data) as Frame);
		}
	}
	return frames;
}

async function main() {
	const cwd = await mkdtemp(join(tmpdir(), "pi-agui-activity-"));
	const port = 39_900 + Math.floor(Math.random() * 90);
	const { listen, supervisor } = createAguiServer({ port, host: "127.0.0.1", cwd });
	const base = await listen();
	console.log(`服务已起：${base}\n工作目录：${cwd}\n`);

	const command = 'for i in $(seq 1 12); do echo "tick $i"; sleep 0.25; done';
	const frames = await runOnce(base, {
		threadId: "activity-thread",
		runId: "activity-run-1",
		messages: [
			{
				id: "m1",
				role: "user",
				content: [
					"用 bash 工具执行下面这条命令，不要改写成别的形式，也不要先解释：",
					command,
					"执行完只回一句「好了」。",
				].join("\n"),
			},
		],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
	});

	const activities = frames.filter((frame) => frame.type === "ACTIVITY_SNAPSHOT");
	const hashes = activities.map((frame) => {
		const content = frame.content as { partial?: string; done?: boolean; durationMs?: number; toolName?: string };
		return `${content.toolName} done=${String(content.done)} chars=${content.partial?.length ?? 0} ${content.durationMs ? `${content.durationMs}ms` : ""}`;
	});

	console.log(`ACTIVITY_SNAPSHOT × ${activities.length}`);
	for (const line of hashes) console.log(`  ${line}`);

	assert.ok(activities.length >= 2, "长命令至少应该产出多帧活动块（执行中 + 收尾）");
	assert.ok(
		activities.every((frame) => frame.activityType === "tool.progress"),
		"活动类型应统一为 tool.progress",
	);

	const withTicks = activities.filter((frame) => String((frame.content as { partial?: string }).partial ?? "").includes("tick"));
	assert.ok(withTicks.length >= 1, "活动块里应该能看到命令的实时输出");

	const finalFrame = activities.at(-1)!;
	const finalContent = finalFrame.content as { done?: boolean; durationMs?: number };
	assert.equal(finalContent.done, true, "最后一帧活动块必须标记 done");
	assert.ok(typeof finalContent.durationMs === "number" && finalContent.durationMs > 0, "最后一帧应带 pi 量的耗时");

	// 工具调用本体也要完整（活动块是旁路，不能替代 TOOL_CALL_*）
	const toolStarts = frames.filter((frame) => frame.type === "TOOL_CALL_START");
	assert.ok(toolStarts.length >= 1, "应该有一次 bash 工具调用");
	assert.equal(toolStarts[0]!.toolCallName, "bash");
	assert.ok(frames.some((frame) => frame.type === "TOOL_CALL_RESULT"), "必须有 TOOL_CALL_RESULT");
	assert.equal(frames.at(-1)?.type, "RUN_FINISHED");

	console.log("\n✅ 活动块冒烟通过");
	supervisor.closeAll();
	process.exit(0);
}

main().catch((error) => {
	console.error("活动块冒烟失败：", error);
	process.exit(1);
});
