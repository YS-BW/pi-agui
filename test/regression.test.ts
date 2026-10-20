import assert from "node:assert/strict";
import { test } from "node:test";
import { EventSchema } from "@ag-ui/core/schemas";
import { createTranslator } from "../src/translate.ts";
import { createUiBridge } from "../src/ui-context.ts";
import { extractRunInput } from "../src/input.ts";
import { input } from "./fixture.ts";

const event = (value: any) => value;
test("terminal events are idempotent, message IDs differ across runs", () => {
	const a = createTranslator({ threadId: "t", runId: "a" });
	const b = createTranslator({ threadId: "t", runId: "b" });
	const text = event({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	});
	const aa = a.translate(text) as any[],
		bb = b.translate(text) as any[];
	assert.notEqual(aa[0].messageId, bb[0].messageId);
	a.start();
	const finished = a.finish();
	finished.forEach((e) => EventSchema.parse(e));
	assert.equal(a.finish().length, 0);
	assert.equal(a.error("late").length, 0);
	assert.equal(a.translate(text).length, 0);
});

test("thinking signature remains attached to its reasoning block after thinking_end", () => {
	const t = createTranslator({ threadId: "t", runId: "r" });
	t.start();
	const start: any[] = t.translate(
		event({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		}),
	);
	t.translate(
		event({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0 },
		}),
	);
	const end: any[] = t.translate(
		event({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "", thinkingSignature: "secret" }],
			},
		}),
	);
	assert.equal(end.find((e) => e.type === "REASONING_ENCRYPTED_VALUE").entityId, start[0].messageId);
});

test("two simultaneous UI requests route by exact requestId, unknown id cannot succeed", async () => {
	const requests: any[] = [];
	const make = () =>
		createUiBridge({
			onRequest: (r) => requests.push(r),
			onNotify() {},
			onStatus() {},
			onWidget() {},
		});
	const a = make(),
		b = make();
	const pa = a.context.confirm("a", "a"),
		pb = b.context.confirm("b", "b");
	assert.equal(a.resolve(requests[1].id, { confirmed: true }), false);
	assert.equal(b.resolve(requests[1].id, { confirmed: true }), true);
	assert.equal(await pb, true);
	assert.equal(a.pendingCount, 1);
	assert.equal(b.resolve(requests[1].id, { confirmed: true }), false);
	a.cancelAll();
	assert.equal(await pa, false);
});

test("tool-only follow-up does not resubmit a historical user message", () => {
	const result = {
		id: "tool",
		role: "tool" as const,
		toolCallId: "c",
		content: "",
	};
	const parsed = extractRunInput({
		...input(),
		messages: [...input().messages, result],
	});
	assert.equal(parsed.text, "");
	assert.deepEqual(parsed.results, [result]);
	assert.throws(
		() =>
			extractRunInput({
				...input(),
				messages: [{ id: "a", role: "assistant", content: "done" }],
			}),
		/latest message/,
	);
});

test("tool argument deltas before the provider assigns name/id are buffered", () => {
	const t = createTranslator({ threadId: "t", runId: "r" });
	t.start();
	const update = (partial: any, delta: string) =>
		event({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				partial,
				delta,
			},
		});
	assert.deepEqual(t.translate(update({ content: [{ type: "toolCall" }] }, '{"city":')), []);
	const out: any[] = t.translate(update({ content: [{ type: "toolCall", id: "call", name: "weather" }] }, '"Paris"}'));
	assert.deepEqual(JSON.parse(out.find((e) => e.type === "TOOL_CALL_ARGS").delta), { city: "Paris" });
	const end: any[] = t.translate(
		event({
			type: "message_update",
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: { id: "call", name: "weather", arguments: { city: "Paris" } },
			},
		}),
	);
	assert.equal(end.filter((e) => e.type === "TOOL_CALL_END").length, 1);
});
