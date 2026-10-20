import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpAgent } from "@ag-ui/client";
import { EventSchema } from "@ag-ui/core/schemas";
import { fixture, input, post, events } from "./fixture.ts";

const timeout = { timeout: 15000 };

test("real Pi SDK → SSE → official HttpAgent, multi-turn and state/context", timeout, async (t) => {
	const f = await fixture((_context, i) => ({ text: `reply ${i}` }));
	t.after(() => f.cleanup());
	const agent = new HttpAgent({ url: f.url, threadId: "client" });
	agent.addMessage({ id: "u1", role: "user", content: "hello" });
	const observed: any[] = [];
	await agent.runAgent(
		{
			runId: "client-1",
			context: [{ description: "page", value: "inventory" }],
		},
		{
			onEvent: ({ event }) => {
				observed.push(event);
			},
		},
	);
	assert.ok(agent.messages.some((m) => m.role === "assistant" && m.content === "reply 0"));
	for (const event of observed) EventSchema.parse(event);
	agent.addMessage({ id: "u2", role: "user", content: "again" });
	await agent.runAgent({ runId: "client-2" });
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[0]), /inventory/);
	assert.ok(agent.messages.some((m) => m.role === "assistant" && m.content === "reply 1"));
	assert.equal(f.supervisor.list().length, 1);
});

test("frontend handoff stops model, then actual result resumes without repeating user", timeout, async (t) => {
	const f = await fixture((_context, i) =>
		i === 0
			? {
					calls: [{ id: "browser-1", name: "pick", arguments: { color: "blue" } }],
				}
			: { text: "accepted" },
	);
	t.after(() => f.cleanup());
	const first = {
		...input(),
		tools: [
			{
				name: "pick",
				description: "Pick a color",
				parameters: {
					type: "object",
					properties: { color: { type: "string" } },
				},
			},
		],
	};
	const start = await events(await post(f.url, first));
	assert.equal(f.requests.length, 1);
	assert.deepEqual(start.at(-1)?.outcome, {
		type: "success",
		pendingToolCallIds: ["browser-1"],
	});
	assert.equal(start.filter((e) => e.type === "TOOL_CALL_RESULT").length, 0);
	for (const event of start) EventSchema.parse(event);
	const result = {
		id: "browser-result",
		role: "tool",
		toolCallId: "browser-1",
		content: [
			{ type: "text", text: "green" },
			{
				type: "image",
				source: {
					type: "data",
					value: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					mimeType: "image/png",
				},
			},
		],
	};
	const finish = await events(
		await post(f.url, {
			...first,
			runId: "r2",
			messages: [...first.messages, result],
		}),
	);
	assert.equal(finish.at(-1)?.type, "RUN_FINISHED");
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[1]), /green/);
	assert.ok(
		JSON.stringify(f.requests[1]).includes(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		),
	);
	const thread = f.supervisor.get("t1")!;
	assert.equal(thread.session.messages.filter((m) => m.role === "user").length, 1);
	assert.ok(thread.messages().some((m) => m.role === "tool" && JSON.stringify(m.content).includes("green")));
});

test("concurrent open deduplicates; busy POST cannot close original stream", timeout, async (t) => {
	let release!: () => void;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = await fixture(() => ({ text: "finished", wait }));
	t.after(() => f.cleanup());
	const [a, b] = await Promise.all([f.supervisor.open("same"), f.supervisor.open("same")]);
	assert.equal(a, b);
	const first = await post(f.url, input("same", "first"));
	const second = await post(f.url, input("same", "second"));
	assert.equal(second.status, 409);
	release();
	const result = await events(first);
	assert.equal(result.at(-1).type, "RUN_FINISHED");
	assert.equal(
		result.some((e) => e.type === "RUN_ERROR"),
		false,
	);
});

test("model error is RUN_ERROR, never false success; next run is usable", timeout, async (t) => {
	const f = await fixture((_context, i) => (i === 0 ? { error: "fixture provider failure" } : { text: "recovered" }));
	t.after(() => f.cleanup());
	const failed = await events(await post(f.url, input()));
	assert.equal(failed.at(-1)?.type, "RUN_ERROR");
	assert.match(failed.at(-1)?.message, /fixture provider failure/);
	assert.equal(
		failed.some((e) => e.type === "RUN_FINISHED"),
		false,
	);
	const recovered = await events(await post(f.url, input("t1", "retry")));
	assert.equal(recovered.at(-1)?.type, "RUN_FINISHED");
});

test("HTTP validates protocol and unknown read paths don't create sessions", timeout, async (t) => {
	const f = await fixture(() => ({ text: "ok" }));
	t.after(() => f.cleanup());
	assert.equal((await post(f.url, {})).status, 400);
	assert.equal((await post(f.url, { ...input(), forwardedProps: { cwd: "/" } })).status, 400);
	assert.equal((await fetch(f.url + "/threads/missing/messages")).status, 404);
	assert.equal((await fetch(f.url + "/threads/missing/events")).status, 404);
	assert.equal(f.supervisor.list().length, 0);
	assert.equal((await fetch(f.url, { method: "POST", body: "{" })).status, 400);
});

test("frontend tool result survives thread disposal and saved binding restores original session", timeout, async (t) => {
	const f = await fixture((_context, i) => (i === 0 ? { calls: [{ id: "persisted-call", name: "pick", arguments: {} }] } : { text: "resumed" }));
	t.after(() => f.cleanup());
	const first = {
		...input(),
		tools: [
			{
				name: "pick",
				description: "pick",
				parameters: { type: "object", properties: {} },
			},
		],
	};
	await events(await post(f.url, first));
	const sessionId = f.supervisor.get("t1")!.sessionId;
	assert.equal(f.supervisor.close("t1"), true);
	const second = await events(
		await post(f.url, {
			...first,
			runId: "r2",
			messages: [
				{
					id: "result",
					role: "tool",
					toolCallId: "persisted-call",
					content: "stored-answer",
				},
			],
		}),
	);
	assert.equal(second.at(-1)?.type, "RUN_FINISHED");
	assert.equal(f.supervisor.get("t1")!.sessionId, sessionId);
	assert.match(JSON.stringify(f.requests.at(-1)), /stored-answer/);
});

test("abort produces cancelled outcome and releases busy flag", timeout, async (t) => {
	const f = await fixture(() => ({ wait: new Promise<void>(() => {}) }));
	t.after(() => f.cleanup());
	const response = await post(f.url, input());
	assert.equal((await post(f.url, {}, "/threads/t1/abort")).status, 200);
	const result = await events(response);
	assert.deepEqual(result.at(-1)?.outcome, { type: "cancelled" });
	assert.equal(f.supervisor.get("t1")!.busy, false);
});

test("state tool changes shared state, but internal calls stay out of snapshots", timeout, async (t) => {
	const f = await fixture((_context, i) =>
		i === 0
			? {
					calls: [
						{
							id: "state-1",
							name: "ag_ui_update_state",
							arguments: { state_updates: { done: true } },
						},
					],
				}
			: { text: "done" },
	);
	t.after(() => f.cleanup());
	const result = await events(await post(f.url, { ...input(), state: { count: 7 } }));
	assert.ok(result.some((e) => e.type === "STATE_SNAPSHOT" && e.snapshot.done && e.snapshot.count === 7));
	assert.equal(
		result.some((e) => e.type === "TOOL_CALL_START"),
		false,
	);
	const snapshot = result.findLast((e) => e.type === "MESSAGES_SNAPSHOT");
	assert.doesNotMatch(JSON.stringify(snapshot), /state-1/);
	assert.ok(!snapshot.messages.some((message: any) => message.role === "assistant" && !message.content && !message.toolCalls?.length));
	assert.match(JSON.stringify(f.requests[0]), /count/);
});

test("HTTP approvals resolve the correct real Pi session among simultaneous requests", timeout, async (t) => {
	const f = await fixture(
		(context) =>
			context.messages.some((m) => m.role === "toolResult")
				? { text: "approved" }
				: {
						calls: [{ id: "confirm-call", name: "confirm_action", arguments: {} }],
					},
		[
			(pi) => {
				pi.registerTool({
					name: "confirm_action",
					label: "confirm",
					description: "confirm",
					parameters: { type: "object", properties: {} } as any,
					async execute(_id, _params, _signal, _update, ctx) {
						const yes = await ctx.ui.confirm("confirm", "continue?");
						return {
							content: [{ type: "text", text: String(yes) }],
							details: {},
						};
					},
				});
			},
		],
	);
	t.after(() => f.cleanup());
	const a = await post(f.url, input("a", "a")),
		b = await post(f.url, input("b", "b"));
	async function requestId(id: string) {
		for (let i = 0; i < 100; i++) {
			const request: any = f.supervisor
				.get(id)
				?.replay(0)
				.find((r) => r.event.type === "CUSTOM" && (r.event as any).name === "pi.ui_request")?.event;
			if (request) return request.value.id as string;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error("Missing UI request");
	}
	const aid = await requestId("a"),
		bid = await requestId("b");
	assert.equal((await post(f.url, { confirmed: "yes" }, `/ui/${bid}`)).status, 400);
	assert.equal(f.supervisor.get("b")?.pendingUiRequests, 1);
	assert.equal((await post(f.url, { confirmed: true }, `/ui/${bid}`)).status, 200);
	assert.equal((await events(b)).at(-1)?.type, "RUN_FINISHED");
	assert.equal(f.supervisor.get("a")?.pendingUiRequests, 1);
	assert.equal((await post(f.url, { confirmed: true }, "/ui/unknown")).status, 404);
	assert.equal((await post(f.url, { confirmed: true }, `/ui/${aid}`)).status, 200);
	assert.equal((await events(a)).at(-1)?.type, "RUN_FINISHED");
});

test("same-name frontend schema changes are reflected in the next provider request", timeout, async (t) => {
	const f = await fixture(() => ({ text: "ok" }));
	t.after(() => f.cleanup());
	const tool = (key: string) => ({
		name: "render",
		description: key,
		parameters: { type: "object", properties: { [key]: { type: "string" } } },
	});
	await events(await post(f.url, { ...input(), tools: [tool("old_field")] }));
	await events(await post(f.url, { ...input("t1", "r2"), tools: [tool("new_field")] }));
	const systemMessages = f.requests[1].messages.filter((m) => m.role === "system");
	assert.match(JSON.stringify(systemMessages.at(-1)), /new_field/);
	assert.doesNotMatch(JSON.stringify(systemMessages.at(-1)), /old_field/);
});

test("tool setup failure releases thread and sends exactly one terminal event", timeout, async (t) => {
	const f = await fixture(() => ({ text: "ok" }));
	t.after(() => f.cleanup());
	const failed = await events(
		await post(f.url, {
			...input(),
			tools: [
				{
					name: "ag_ui_update_state",
					description: "collision",
					parameters: {},
				},
			],
		}),
	);
	assert.equal(failed.filter((e) => e.type === "RUN_ERROR").length, 1);
	assert.equal(f.supervisor.get("t1")?.busy, false);
	const success = await events(await post(f.url, input("t1", "r2")));
	assert.equal(success.at(-1)?.type, "RUN_FINISHED");
});

test("closing an SSE client does not abort the run; replay connection stays live", timeout, async (t) => {
	let release!: () => void;
	const f = await fixture(() => ({
		text: "replayed",
		wait: new Promise<void>((r) => {
			release = r;
		}),
	}));
	t.after(() => f.cleanup());
	const response = await post(f.url, input());
	await response.body!.cancel();
	const controller = new AbortController();
	const replay = await fetch(f.url + "/threads/t1/events", {
		signal: controller.signal,
	});
	const reader = replay.body!.getReader();
	const initial = await reader.read();
	assert.match(new TextDecoder().decode(initial.value), /id: 1/);
	for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
	release();
	let received = "";
	while (!received.includes("RUN_FINISHED")) {
		const next = await reader.read();
		if (next.done) break;
		received += new TextDecoder().decode(next.value);
	}
	assert.match(received, /replayed/);
	assert.match(received, /RUN_FINISHED/);
	controller.abort();
});

test("extension-handled input still closes the run without a provider request", timeout, async (t) => {
	const f = await fixture(
		() => ({ text: "not called" }),
		[
			(pi) => {
				pi.on("input", () => ({ action: "handled" }));
			},
		],
	);
	t.after(() => f.cleanup());
	const result = await events(await post(f.url, input()));
	assert.equal(result.at(-1)?.type, "RUN_FINISHED");
	assert.equal(f.requests.length, 0);
	assert.equal(f.supervisor.get("t1")?.busy, false);
});

test("inline image reaches Pi and survives authoritative messages snapshot", timeout, async (t) => {
	const f = await fixture(() => ({ text: "image received" }));
	t.after(() => f.cleanup());
	const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
	const content = [
		{ type: "text", text: "describe" },
		{
			type: "image",
			source: { type: "data", value: imageBase64, mimeType: "image/png" },
		},
	];
	const result = await events(
		await post(f.url, {
			...input(),
			messages: [{ id: "image", role: "user", content }],
		}),
	);
	assert.ok(JSON.stringify(f.requests[0]).includes(imageBase64));
	const snapshot = result.find((e) => e.type === "MESSAGES_SNAPSHOT");
	assert.deepEqual(snapshot.messages.find((m: any) => m.role === "user").content, content);
	for (const e of result) EventSchema.parse(e);
});
