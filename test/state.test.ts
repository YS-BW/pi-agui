/**
 * 共享状态（STATE_*）与前端工具桥的单测。
 * 两者都不碰网络：状态是纯内存合并，前端工具只验「转成 pi 工具后返回什么」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createStateStore, createStateTool, extractStateUpdates, STATE_TOOL_NAME } from "../src/state.ts";
import { toFrontendAgentTools } from "../src/frontend-tools.ts";
import { FORWARDED_TO_CLIENT } from "../src/translate.ts";

test("extractStateUpdates：支持 { state_updates } 和裸对象两种形状", () => {
	assert.deepEqual(extractStateUpdates({ state_updates: { a: 1 } }), { a: 1 });
	assert.deepEqual(extractStateUpdates({ a: 1 }), { a: 1 });
	// 模型有时会把 JSON 塞成字符串
	assert.deepEqual(extractStateUpdates({ state_updates: '{"a":1}' }), { a: 1 });
	// 数组不是合法状态
	assert.throws(() => extractStateUpdates({ state_updates: [1, 2] }), /必须是对象/);
	assert.throws(() => extractStateUpdates({ state_updates: "{坏的" }), /合法 JSON/);
});

test("createStateStore：浅合并，值没变时不算变化", () => {
	const store = createStateStore({ a: 1, b: { c: 2 } });
	assert.deepEqual(store.get(), { a: 1, b: { c: 2 } });

	assert.equal(store.merge({ state_updates: { a: 2 } }), true);
	assert.deepEqual(store.get(), { a: 2, b: { c: 2 } });

	// 同样的值再写一次：没有变化，调用方就不应该推 STATE_SNAPSHOT
	assert.equal(store.merge({ a: 2 }), false);

	// 合并是浅的：嵌套对象整体替换
	assert.equal(store.merge({ b: { d: 3 } }), true);
	assert.deepEqual(store.get(), { a: 2, b: { d: 3 } });

	store.reset({ fresh: true });
	assert.deepEqual(store.get(), { fresh: true });
	// 非对象重置当成清空
	store.reset(undefined);
	assert.deepEqual(store.get(), {});
});

test("createStateTool：改动了才回调，返回值是给人看的文本", async () => {
	const store = createStateStore({ step: 0 });
	const snapshots: Record<string, unknown>[] = [];
	const tool = createStateTool({ store, onChanged: (snapshot) => snapshots.push(snapshot) });

	assert.equal(tool.name, STATE_TOOL_NAME);
	assert.equal(typeof tool.description, "string");
	assert.ok((tool.description ?? "").length > 0);

	const first = await tool.execute("call_1", { state_updates: { step: 1 } }, undefined, undefined);
	assert.deepEqual(snapshots, [{ step: 1 }]);
	assert.equal((first.content as any[])[0].text, "UI state updated.");

	const second = await tool.execute("call_2", { state_updates: { step: 1 } }, undefined, undefined);
	assert.equal(snapshots.length, 1, "值没变就不该再推快照");
	assert.match((second.content as any[])[0].text, /nothing changed/);
});

test("toFrontendAgentTools：转成 pi 工具，调用即回占位文本", async () => {
	const forwarded: string[] = [];
	const tools = toFrontendAgentTools(
		[
			{ name: "pieChart", description: "画饼图", parameters: { type: "object", properties: { data: { type: "array" } } } },
			{ name: "toggleTheme", description: "", parameters: undefined as never },
		],
		{ onForwarded: (name) => forwarded.push(name) },
	);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["pieChart", "toggleTheme"],
	);
	// 没有 description 的也要给一句，否则模型不知道这工具干嘛的
	assert.match(String(tools[1]!.description), /toggleTheme/);

	const result = await tools[0]!.execute("call_1", { data: [1, 2, 3] }, undefined, undefined);
	assert.equal((result.content as any[])[0].text, FORWARDED_TO_CLIENT);
	assert.deepEqual(forwarded, ["pieChart"]);
});

test("toFrontendAgentTools：去重、跳过内部工具和非法定义", () => {
	const tools = toFrontendAgentTools(
		[
			{ name: "dup", description: "x", parameters: {} },
			{ name: "dup", description: "y", parameters: {} },
			{ name: STATE_TOOL_NAME, description: "内部工具", parameters: {} },
			{ name: "", description: "空名字", parameters: {} },
			null as never,
		],
		{ exclude: [STATE_TOOL_NAME] },
	);

	assert.deepEqual(
		tools.map((tool) => tool.name),
		["dup"],
	);
	// 空 tools 直接返回空数组，不要造出个幽灵工具
	assert.deepEqual(toFrontendAgentTools(undefined), []);
	assert.deepEqual(toFrontendAgentTools([]), []);
});
