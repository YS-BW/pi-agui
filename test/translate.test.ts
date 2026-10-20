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
	assert.deepEqual(first[0], { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" });
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

	const end = translator.translate(asEvent({ type: "message_end", message: {} }));
	assert.deepEqual(types(end), [EventType.TEXT_MESSAGE_END]);
	assert.equal(field(end[0], "messageId"), messageId);
});

test("纯工具调用轮：补一条空助手消息当父消息，工具调用挂上去", () => {
	const translator = makeTranslator();
	translator.start();
	translator.translate(asEvent({ type: "message_start", message: { role: "assistant" } }));
	// 这一轮只有 toolCall，没有文本
	translator.translate(asEvent({ type: "message_end", message: {} }));

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
	translator.translate(asEvent({ type: "message_end", message: {} }));

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
