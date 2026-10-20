/**
 * 能力冒烟：用**真实的 pi agent**（默认模型 + 内置 bash/read/write 工具）验证
 * AG-UI 侧的四个新增能力：
 *
 *   1. 前端工具桥   —— 模型调用只在浏览器里执行的工具，后端回占位符
 *   2. 共享状态     —— 模型调 ag_ui_update_state，前端只看到 STATE_SNAPSHOT
 *   3. 活动块       —— 长命令执行中的进度翻成 ACTIVITY_SNAPSHOT
 *   4. 消息快照     —— 每个 run 收尾都发 MESSAGES_SNAPSHOT
 *
 * 跑法：node examples/capabilities-smoke.ts
 * 需要真实模型的 key（读 ~/.pi/agent 的配置）。
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
	const cwd = await mkdtemp(join(tmpdir(), "pi-agui-cap-"));
	const port = 39_600 + Math.floor(Math.random() * 300);
	const { listen, supervisor } = createAguiServer({ port, host: "127.0.0.1", cwd });
	const base = await listen();
	console.log(`服务已起：${base}\n工作目录：${cwd}\n`);

	const threadId = "capability-thread";
	const frames = await runOnce(base, {
		threadId,
		runId: "capability-run-1",
		messages: [
			{
				id: "m1",
				role: "user",
				content: [
					"按顺序做三件事，每件都要真的调用工具，不要只在文字里描述：",
					"1) 调用 ag_ui_update_state，把 state 更新成 {\"step\": 1, \"status\": \"working\"}；",
					"2) 调用 pieChart，参数 {\"title\": \"示例\", \"data\": [{\"label\": \"A\", \"value\": 3}, {\"label\": \"B\", \"value\": 5}]}；",
					"3) 最后用一句话说明你做完了。",
				].join("\n"),
			},
		],
		tools: [
			{
				name: "pieChart",
				description: "在浏览器里渲染一个饼图。参数是标题和数据数组。",
				parameters: {
					type: "object",
					properties: {
						title: { type: "string" },
						data: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } } } },
					},
					required: ["title", "data"],
				},
			},
		],
		context: [],
		state: {},
		forwardedProps: {},
	});

	if (process.env.PI_AGUI_DEBUG_TOOLS) {
		const text = frames.filter((f) => f.type === "TEXT_MESSAGE_CONTENT").map((f) => String(f.delta)).join("");
		console.log("\n模型文本：", text.slice(0, 1500));
		for (const start of frames.filter((f) => f.type === "TOOL_CALL_START")) {
			const args = frames.filter((f) => f.type === "TOOL_CALL_ARGS" && f.toolCallId === start.toolCallId).map((f) => String(f.delta)).join("");
			console.log(`  ${String(start.toolCallName)}(${args.slice(0, 160)})`);
		}
	}

	const counts = new Map<string, number>();
	for (const frame of frames) {
		const key = frame.type === "CUSTOM" ? `CUSTOM:${String(frame.name)}` : frame.type;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	console.log("事件统计：");
	for (const [key, count] of counts) console.log(`  ${key} × ${count}`);

	const toolStarts = frames.filter((frame) => frame.type === "TOOL_CALL_START");
	const toolNames = toolStarts.map((frame) => String(frame.toolCallName));
	console.log(`\n模型调用过的工具：${toolNames.join(", ") || "（无）"}`);

	const snapshots = frames.filter((frame) => frame.type === "STATE_SNAPSHOT");
	const activities = frames.filter((frame) => frame.type === "ACTIVITY_SNAPSHOT");
	const messages = frames.filter((frame) => frame.type === "MESSAGES_SNAPSHOT");
	const results = frames.filter((frame) => frame.type === "TOOL_CALL_RESULT");

	const threaded = results.filter((frame) =>
		(toolNames.includes("pieChart") ? toolStarts.find((start) => start.toolCallId === frame.toolCallId) : false),
	);
	console.log(`pieChart 的工具结果：${threaded.map((frame) => JSON.stringify(frame.content)).join(" | ") || "（无）"}`);

	// ---- 断言 ----
	assert.equal(frames[0]?.type, "RUN_STARTED", "第一个事件必须是 RUN_STARTED");
	assert.equal(frames.at(-1)?.type, "RUN_FINISHED", "最后一个事件必须是 RUN_FINISHED");

	assert.ok(toolNames.includes("pieChart"), "模型应该调用了前端工具 pieChart");
	const pieResult = results.find((frame) => frame.toolCallId === toolStarts.find((start) => start.toolCallName === "pieChart")?.toolCallId);
	assert.equal(pieResult?.content, "Forwarded to client", "前端工具的结果必须是占位符");

	assert.ok(!toolNames.includes("ag_ui_update_state"), "内部状态工具不能出现在事件流里");
	assert.ok(snapshots.length >= 1, "应该有 STATE_SNAPSHOT");
	const snapshot = snapshots.at(-1)?.snapshot as Record<string, unknown>;
	assert.equal(snapshot.step, 1, "状态快照里应该有模型写入的 step");

	assert.ok(messages.length >= 1, "每个 run 结束都要发 MESSAGES_SNAPSHOT");
	const lastMessages = messages.at(-1)?.messages as unknown[];
	assert.ok(lastMessages.length >= 2, "快照里至少要有用户消息和助手消息");

	// AG-UI 的 RUN_FINISHED.usage 直接吃 pi 的 AssistantMessage.usage，必须真的有数
	const finished = frames.at(-1)!;
	const usage = finished.usage as Array<Record<string, unknown>> | undefined;
	assert.ok(Array.isArray(usage) && usage.length >= 1, "RUN_FINISHED 必须带 token 用量");
	assert.ok((usage![0]!.inputTokens as number) > 0, "inputTokens 应该大于 0");
	assert.ok((usage![0]!.outputTokens as number) > 0, "outputTokens 应该大于 0");
	assert.equal(finished.outcome, undefined, "正常结束不该带 outcome");

	console.log(`\nACTIVITY_SNAPSHOT × ${activities.length}（本次没有长命令，0 也正常）`);
	console.log(`用量：${JSON.stringify(usage)}`);
	console.log("✅ 能力冒烟全部通过");

	supervisor.closeAll();
	process.exit(0);
}

main().catch((error) => {
	console.error("能力冒烟失败：", error);
	process.exit(1);
});
