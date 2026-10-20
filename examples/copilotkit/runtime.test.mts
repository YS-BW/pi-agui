import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiEndpoint } from "./runtime.mts";
import { fixture, input, events } from "../../test/fixture.ts";

test("CopilotKit runtime v2 forwards real Pi events and frontend tool continuation", { timeout: 20000 }, async (t) => {
	const f = await fixture((_context, i) => (i === 0 ? { calls: [{ id: "ui-call", name: "choose", arguments: {} }] } : { text: "complete" }));
	t.after(() => f.cleanup());
	const endpoint = createPiEndpoint(f.url);
	const run = async (body: unknown) => {
		const response = await endpoint.request("/api/copilotkit/agent/default/run", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 200);
		return events(response);
	};
	const first = {
		...input("runtime", "run1"),
		tools: [
			{
				name: "choose",
				description: "Choose",
				parameters: { type: "object", properties: {} },
			},
		],
	};
	const a = await run(first);
	assert.ok(a.some((e) => e.type === "TOOL_CALL_END" && e.toolCallId === "ui-call"));
	assert.ok(a.some((e) => e.type === "RUN_FINISHED" && e.outcome?.pendingToolCallIds?.includes("ui-call")));
	assert.equal(f.requests.length, 1);
	const b = await run({
		...first,
		runId: "run2",
		messages: [
			...first.messages,
			{
				id: "result",
				role: "tool",
				toolCallId: "ui-call",
				content: "approved",
			},
		],
	});
	assert.ok(b.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "complete"));
	assert.equal(f.requests.length, 2);
	assert.match(JSON.stringify(f.requests[1]), /approved/);
});
