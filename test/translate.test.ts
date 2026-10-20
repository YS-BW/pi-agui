/**
 * 翻译层单测：不碰网络、不碰模型，纯事件进 / 事件出。
 * 跑法：npm test
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { EventType } from "@ag-ui/core";

import { createTranslator, stringifyToolResult } from "../src/translate.ts";

/** 只喂翻译层关心的字段，其余用 any 兜过去 */
const asEvent = (event: unknown) => event as AgentSessionEvent;

const types = (events: { type: string }[]) => events.map((event) => event.type);

/** 事件对象上的字段，测试里不要跟联合类型较劲 */
const field = (event: { type: string }, key: string) => (event as unknown as Record<string, unknown>)[key];

function makeTranslator() {
	return createTranslator({ threadId: "t1", runId: "r1" });
}

test("start 只发一次 RUN_STARTED", () => {
	const translator = makeTranslator();
	const first = translator.start();
	assert.deepEqual(types(first), [EventType.RUN_STARTED]);
	assert.deepEqual(first[0], { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1", protocolVersion: "1.0" });
	// agent_start 不重复发
	assert.deepEqual(translator.translate(asEvent({ type: "agent_start" })), []);
	assert.deepEqual(translator.start(), []);
});

test("文本增量：第一次 delta 才开 TEXT_MESSAGE_START，message_end 关掉", () => {
	const translator = makeTranslator();
	translator.start();

	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	const first = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "你" } }),
	);
	assert.deepEqual(types(first), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]);
	const messageId = field(first[0], "messageId");

	const second = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "好" } }),
	);
	assert.deepEqual(types(second), [EventType.TEXT_MESSAGE_CONTENT]);
	// 同一条消息的 id 必须稳定
	assert.equal(field(second[0], "messageId"), messageId);

	const end = translator.translate(asEvent({ type: "message_end", message: { role: "assistant", content: [] } }));
	assert.deepEqual(types(end), [EventType.TEXT_MESSAGE_END]);
	assert.equal(field(end[0], "messageId"), messageId);
});

test("纯工具调用轮：补一条空助手消息当父消息，工具调用挂上去", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	// 这一轮只有 toolCall，没有文本
	translator.translate(asEvent({ type: "message_end", message: { role: "assistant", content: [] } }));

	const start = translator.translate(
		asEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "a.txt" } }),
	);
	assert.deepEqual(types(start), [
		EventType.TEXT_MESSAGE_START,
		EventType.TEXT_MESSAGE_END,
		EventType.TOOL_CALL_START,
		EventType.TOOL_CALL_ARGS,
	]);
	const parentMessageId = field(start[0], "messageId");
	assert.equal(field(start[2], "parentMessageId"), parentMessageId);
	assert.equal(field(start[2], "toolCallName"), "read");
	assert.deepEqual(JSON.parse(field(start[3], "delta") as string), { path: "a.txt" });

	const end = translator.translate(
		asEvent({ type: "tool_execution_end", toolCallId: "call_1", toolName: "read", result: { content: [{ type: "text", text: "文件内容" }] }, isError: false }),
	);
	assert.deepEqual(types(end), [EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT]);
	assert.equal(field(end[1], "toolCallId"), "call_1");
	assert.equal(field(end[1], "content"), "文件内容");
	assert.equal(field(end[1], "role"), "tool");
});

test("文本 + 工具：工具调用挂在已经关闭的文本消息上", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	const text = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "我查一下" } }),
	);
	const textMessageId = field(text[0], "messageId");
	translator.translate(asEvent({ type: "message_end", message: { role: "assistant", content: [] } }));

	const toolStart = translator.translate(
		asEvent({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { cmd: "ls" } }),
	);
	assert.deepEqual(types(toolStart), [EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS]);
	assert.equal(field(toolStart[0], "parentMessageId"), textMessageId);
});

test("agent_end 不收尾，agent_settled 才发 RUN_FINISHED", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	translator.translate(asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "x" } }));

	// willRetry=true 时 agent_end 后面还会重跑，绝不能在这里收尾
	assert.deepEqual(translator.translate(asEvent({ type: "agent_end", messages: [], willRetry: true })), []);

	const settled = translator.translate(asEvent({ type: "agent_settled", aborted: false }));
	assert.deepEqual(types(settled), [EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
});

test("推理块：thinking_delta 开 REASONING_*，文本开始时关掉", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));

	const thinking = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "想想" } }),
	);
	assert.deepEqual(types(thinking), [
		EventType.REASONING_START,
		EventType.REASONING_MESSAGE_START,
		EventType.REASONING_MESSAGE_CONTENT,
	]);

	const more = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "再看" } }),
	);
	assert.deepEqual(types(more), [EventType.REASONING_MESSAGE_CONTENT]);

	const textStart = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "答案" } }),
	);
	assert.deepEqual(types(textStart), [
		EventType.REASONING_MESSAGE_END,
		EventType.REASONING_END,
		EventType.TEXT_MESSAGE_START,
		EventType.TEXT_MESSAGE_CONTENT,
	]);
});

test("close() 补齐所有没关的块，不留给前端半截状态", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "turn_start" }));
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	translator.translate(asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "半句" } }));
	translator.translate(asEvent({ type: "tool_execution_start", toolCallId: "call_3", toolName: "grep", args: {} }));

	const closed = translator.close();
	// 文本块在 tool_execution_start 时就被关掉了，所以 close() 只需要补工具调用和 step
	assert.deepEqual(types(closed), [EventType.TOOL_CALL_END, EventType.STEP_FINISHED]);
	// 再关一次不能重复发
	assert.deepEqual(translator.close(), []);
});

test("错误路径：先补齐块再发 RUN_ERROR", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	translator.translate(asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "x" } }));

	const events = translator.error("没有 API key");
	assert.deepEqual(types(events), [EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
	assert.equal(field(events[1], "message"), "没有 API key");
});

test("其他 pi 事件降级成 CUSTOM，不丢信息也不污染标准事件", () => {
	const translator = makeTranslator();
	assert.deepEqual(
		types(translator.translate(asEvent({ type: "compaction_start", reason: "threshold" }))),
		[EventType.CUSTOM],
	);
	assert.deepEqual(
		types(translator.translate(asEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "boom" }))),
		[EventType.CUSTOM],
	);
	// 未知事件丢弃而不是抛错，保证长跑的服务不被一个新事件类型搞崩
	assert.deepEqual(translator.translate(asEvent({ type: "entry_appended", entry: {} })), []);
});

test("工具结果压平：字符串 / pi 的 content 数组 / 超长截断", () => {
	assert.equal(stringifyToolResult("直接是字符串", 100), "直接是字符串");
	assert.equal(stringifyToolResult({ content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] }, 100), "第一段\n第二段");
	assert.equal(stringifyToolResult({ details: { a: 1 } }, 100), '{"details":{"a":1}}');

	const truncated = stringifyToolResult("x".repeat(500), 100);
	assert.ok(truncated.includes("已截断"));
	assert.ok(truncated.length < 200);
});

test("推理签名：message_end 时把 thinkingSignature 翻成 REASONING_ENCRYPTED_VALUE", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	translator.translate(asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta: "盘算" } }));

	const end = translator.translate(
		asEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "盘算", thinkingSignature: "sig_abc" },
					{ type: "text", text: "好" },
				],
			},
		}),
	);

	const encrypted = end.filter((event) => event.type === EventType.REASONING_ENCRYPTED_VALUE);
	assert.equal(encrypted.length, 1);
	assert.equal(field(encrypted[0]!, "subtype"), "message");
	assert.equal(field(encrypted[0]!, "encryptedValue"), "sig_abc");
	assert.ok(field(encrypted[0]!, "entityId"));
	// 加密值必须排在 REASONING_END 之后，前端才会把它挂到同一条推理消息上
	const order = types(end);
	assert.ok(order.indexOf(EventType.REASONING_END) < order.indexOf(EventType.REASONING_ENCRYPTED_VALUE));
});

test("没有签名时绝不发 REASONING_ENCRYPTED_VALUE", () => {
	const translator = makeTranslator();
	translator.start();
	const end = translator.translate(
		asEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "无签名", redacted: true }] } }),
	);
	assert.deepEqual(end, []);
});

test("工具进度：tool_execution_update 翻成 ACTIVITY_SNAPSHOT，结束时固化", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "tool_execution_start", toolCallId: "call_u", toolName: "grep", args: { pattern: "x" } }));

	const update = translator.translate(
		asEvent({ type: "tool_execution_update", toolCallId: "call_u", toolName: "grep", args: {}, partialResult: "已命中 3 处" }),
	);
	assert.deepEqual(types(update), [EventType.ACTIVITY_SNAPSHOT]);
	assert.equal(field(update[0]!, "activityType"), "tool.progress");
	assert.equal(field(update[0]!, "replace"), true);
	assert.equal(field(update[0]!, "messageId"), "act_tool_call_u");
	assert.equal((field(update[0]!, "content") as Record<string, unknown>).partial, "已命中 3 处");

	const end = translator.translate(
		asEvent({ type: "tool_execution_end", toolCallId: "call_u", toolName: "grep", result: "完成", isError: false }),
	);
	const activity = end.find((event) => event.type === EventType.ACTIVITY_SNAPSHOT);
	assert.ok(activity);
	assert.equal((field(activity!, "content") as Record<string, unknown>).done, true);

	// 工具有没发过进度，结束时就别凭空造一个 activity
	const plain = createTranslator({ threadId: "t1", runId: "r1" });
	plain.start();
	plain.translate(asEvent({ type: "tool_execution_start", toolCallId: "call_v", toolName: "ls", args: {} }));
	const plainEnd = plain.translate(asEvent({ type: "tool_execution_end", toolCallId: "call_v", toolName: "ls", result: "a", isError: false }));
	assert.ok(!plainEnd.some((event) => event.type === EventType.ACTIVITY_SNAPSHOT));
});

test("内部工具不出现在事件流里，但副作用（状态快照）由调用方自己发", () => {
	const translator = createTranslator({ threadId: "t1", runId: "r1", internalTools: ["ag_ui_update_state"] });
	translator.start();

	const start = translator.translate(
		asEvent({ type: "tool_execution_start", toolCallId: "call_s", toolName: "ag_ui_update_state", args: { state_updates: { step: 1 } } }),
	);
	assert.deepEqual(start, []);
	// 内部工具的 update / end 也不能漏出来
	assert.deepEqual(
		translator.translate(asEvent({ type: "tool_execution_update", toolCallId: "call_s", toolName: "ag_ui_update_state", args: {}, partialResult: "x" })),
		[],
	);
	assert.deepEqual(
		translator.translate(asEvent({ type: "tool_execution_end", toolCallId: "call_s", toolName: "ag_ui_update_state", result: "ok", isError: false })),
		[],
	);
	// 而且不能污染父消息状态：后面的工具调用仍能正常开
	const normal = translator.translate(asEvent({ type: "tool_execution_start", toolCallId: "call_n", toolName: "read", args: {} }));
	assert.deepEqual(types(normal), [
		EventType.TEXT_MESSAGE_START,
		EventType.TEXT_MESSAGE_END,
		EventType.TOOL_CALL_START,
		EventType.TOOL_CALL_ARGS,
	]);
});

test("MESSAGES_SNAPSHOT：close() 时发一次权威快照，没有 getMessages 就不发", () => {
	const messages = [{ id: "m1", role: "user", content: "你好" }] as never[];

	const withSnapshot = createTranslator({ threadId: "t1", runId: "r1", getMessages: () => messages });
	withSnapshot.start();
	const closed = withSnapshot.close();
	assert.deepEqual(types(closed), [EventType.MESSAGES_SNAPSHOT]);
	assert.deepEqual(field(closed[0]!, "messages"), messages);

	const without = createTranslator({ threadId: "t1", runId: "r1" });
	without.start();
	assert.deepEqual(types(without.close()), []);
});

test("压缩成功后立刻补 MESSAGES_SNAPSHOT，压缩失败不补", () => {
	const translator = createTranslator({
		threadId: "t1",
		runId: "r1",
		getMessages: () => [{ id: "m1", role: "user", content: "压缩后的历史" }] as never[],
	});
	translator.start();

	const ok = translator.translate(asEvent({ type: "compaction_end", reason: "threshold", result: { summary: "s" }, aborted: false, willRetry: false }));
	assert.deepEqual(types(ok), [EventType.CUSTOM, EventType.MESSAGES_SNAPSHOT]);

	const failed = translator.translate(asEvent({ type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false }));
	assert.deepEqual(types(failed), [EventType.CUSTOM]);
});

test("activity()：外部（扩展 setWidget）能主动推活动块", () => {
	const translator = makeTranslator();
	// run 还没开始时不发，避免发出不属于任何 run 的事件
	assert.deepEqual(translator.activity("ui.widget", "todo", { lines: ["a"] }), []);

	translator.start();
	const events = translator.activity("ui.widget", "widget_todo", { key: "todo", lines: ["a", "b"] }, true);
	assert.deepEqual(types(events), [EventType.ACTIVITY_SNAPSHOT]);
	assert.equal(field(events[0]!, "messageId"), "act_widget_todo");
	assert.equal(field(events[0]!, "activityType"), "ui.widget");
	assert.equal(field(events[0]!, "replace"), true);
});

test("bash 实时输出：首片发 ACTIVITY_SNAPSHOT，后续发 ACTIVITY_DELTA 增量补丁", () => {
	const translator = makeTranslator();
	translator.start();

	const first = translator.translate(asEvent({ type: "bash_execution_update", id: "call_1", delta: "正在编译\n" }));
	assert.deepEqual(types(first), [EventType.ACTIVITY_SNAPSHOT]);
	assert.equal(field(first[0], "activityType"), "bash.output");
	assert.deepEqual((field(first[0], "content") as { chunks: string[] }).chunks, ["正在编译\n"]);

	const second = translator.translate(asEvent({ type: "bash_execution_update", id: "call_1", delta: "完成\n" }));
	assert.deepEqual(types(second), [EventType.ACTIVITY_DELTA]);
	// 增量补丁只带新的一片，不重发全文
	assert.deepEqual(field(second[0], "patch"), [{ op: "add", path: "/chunks/-", value: "完成\n" }]);
	// 同一路输出必须复用同一个 messageId
	assert.equal(field(second[0], "messageId"), field(first[0], "messageId"));
});

test("redacted thinking 只有 start/end 没有 delta，也要配对开出推理块并带上签名", () => {
	const translator = makeTranslator();
	translator.start();

	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	const started = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_start" } }),
	);
	assert.deepEqual(types(started), [EventType.REASONING_START, EventType.REASONING_MESSAGE_START]);
	const reasoningId = field(started[0], "messageId");

	const ended = translator.translate(
		asEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "", thinkingSignature: "sig_abc" }],
			},
		}),
	);
	assert.deepEqual(types(ended), [EventType.REASONING_MESSAGE_END, EventType.REASONING_END, EventType.REASONING_ENCRYPTED_VALUE]);
	// 签名必须挂回同一个推理块，否则前端多轮对不上
	assert.equal(field(ended[2], "entityId"), reasoningId);
	assert.equal(field(ended[2], "encryptedValue"), "sig_abc");
});

test("RUN_FINISHED 带 token 用量，按 provider/model 分桶", () => {
	const translator = makeTranslator();
	translator.start();

	translator.translate(
		asEvent({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude",
				usage: { input: 100, output: 20, totalTokens: 120, reasoning: 5, cacheRead: 80, cacheWrite: 10 },
			},
		}),
	);
	translator.translate(
		asEvent({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "anthropic",
				model: "claude",
				usage: { input: 50, output: 10, totalTokens: 60 },
			},
		}),
	);

	const finished = translator.translate(asEvent({ type: "agent_settled", aborted: false }));
	const last = finished[finished.length - 1]!;
	assert.equal(last.type, EventType.RUN_FINISHED);
	assert.equal(field(last, "outcome"), undefined);
	const usage = field(last, "usage") as Array<Record<string, number>>;
	assert.equal(usage.length, 1);
	assert.equal(usage[0]!.inputTokens, 150);
	assert.equal(usage[0]!.outputTokens, 30);
	assert.equal(usage[0]!.totalTokens, 180);
	assert.equal(usage[0]!.reasoningTokens, 5);
	assert.equal(usage[0]!.cachedInputTokens, 80);
	assert.equal(usage[0]!.cacheWriteInputTokens, 10);
});

test("被 abort 的 run 收尾报 cancelled，不能当成功", () => {
	const translator = makeTranslator();
	translator.start();

	const finished = translator.translate(asEvent({ type: "agent_settled", aborted: true }));
	const last = finished[finished.length - 1]!;
	assert.equal(last.type, EventType.RUN_FINISHED);
	assert.deepEqual(field(last, "outcome"), { type: "cancelled" });
});

test("provider 不吐 delta 时，text_end 的全文要补齐，且不重复", () => {
	const translator = makeTranslator();
	translator.start();

	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	translator.translate(asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_start" } }));
	const first = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta: "前半" } }),
	);
	assert.equal(field(first[0], "delta"), "前半");

	// text_end 带完整全文（前半 + 后半），只该补「后半」
	const end = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", content: "前半后半" } }),
	);
	assert.deepEqual(types(end), [EventType.TEXT_MESSAGE_CONTENT]);
	assert.equal(field(end[0], "delta"), "后半");

	// 完全没 delta 的 provider：text_end 一次发全
	const other = makeTranslator();
	other.start();
	other.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	const onlyEnd = other.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_end", content: "整段" } }),
	);
	assert.deepEqual(types(onlyEnd), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT]);
	assert.equal(field(onlyEnd[1], "delta"), "整段");
});

test("工具调用流式：toolcall_start 就发 TOOL_CALL_START，delta 逐段发 ARGS，execution_start 不重复", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));

	const partial = (argsText: string) => ({
		content: [{ type: "toolCall", id: "call_9", name: "bash", arguments: {} , _raw: argsText }],
	});

	const started = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: partial("") } }),
	);
	assert.deepEqual(types(started), [EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_END, EventType.TOOL_CALL_START]);
	assert.equal(field(started[2], "toolCallId"), "call_9");
	assert.equal(field(started[2], "toolCallName"), "bash");
	const parentMessageId = field(started[2], "parentMessageId");
	// 纯工具轮：补一条空助手消息当父消息
	assert.equal(field(started[0], "messageId"), parentMessageId);

	const delta = translator.translate(
		asEvent({ type: "message_update", message: {}, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}', partial: partial('{"command":"ls"}') } }),
	);
	assert.deepEqual(types(delta), [EventType.TOOL_CALL_ARGS]);
	assert.equal(field(delta[0], "delta"), '{"command":"ls"}');

	// 执行开始不能重复发 START / ARGS
	const execStart = translator.translate(asEvent({ type: "tool_execution_start", toolCallId: "call_9", toolName: "bash", args: { command: "ls" } }));
	assert.deepEqual(types(execStart), []);

	const end = translator.translate(asEvent({ type: "tool_execution_end", toolCallId: "call_9", toolName: "bash", result: "a.txt", isError: false, durationMs: 12 }));
	assert.deepEqual(types(end), [EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT]);
	assert.equal(field(end[1], "content"), "a.txt");
});

test("工具调用级别的推理签名走 subtype tool-call", () => {
	const translator = makeTranslator();
	translator.start();

	const out = translator.translate(
		asEvent({
			type: "message_update",
			message: {},
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "call_7", name: "bash", arguments: {}, thoughtSignature: "sig_tool" },
				partial: {},
			},
		}),
	);
	const signature = out.find((event) => event.type === EventType.REASONING_ENCRYPTED_VALUE)!;
	assert.equal(field(signature, "subtype"), "tool-call");
	assert.equal(field(signature, "entityId"), "call_7");
	assert.equal(field(signature, "encryptedValue"), "sig_tool");
});
