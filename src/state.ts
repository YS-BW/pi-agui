/**
 * AG-UI 共享状态（STATE_*）在 pi 侧的对应物。
 *
 * AG-UI 的状态模型：一个 run 带 `state` 进来，agent 可以中途改它，
 * 每次变化推一版 `STATE_SNAPSHOT`，前端据此渲染看板 / 表单之类的派生 UI。
 *
 * pi 没有「共享状态」这个概念，所以这里补两样东西：
 *  1. 一个纯内存的 state 容器（浅合并，与官方 @ag-ui/claude-agent-sdk 一致）；
 *  2. 一个 pi 工具 `ag_ui_update_state`，让模型能主动改状态。
 *
 * 注意 state 工具是「内部工具」：它不进 AG-UI 的工具调用事件流，
 * 前端只会看到状态变化，不会看到「模型调用了一个更新状态的工具」。
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** 从 pi 的会话类型里推出工具类型，避免直接依赖 pi-agent-core 这个子包 */
export type PiAgentTool = AgentSession["state"]["tools"][number];

/** 工具名，与官方 Claude adapter 保持一致 */
export const STATE_TOOL_NAME = "ag_ui_update_state";

export interface StateStore {
	/** 当前状态（只读引用，修改请走 merge） */
	get(): Record<string, unknown>;
	/** 浅合并，返回是否真的发生了变化 */
	merge(input: unknown): boolean;
	/** 整体重置（新 run 传入 state 时用） */
	reset(next: unknown): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从工具参数里提取状态增量。
 * 官方实现支持两种形状：`{ state_updates: {...} }` 和直接给对象。
 */
export function extractStateUpdates(input: unknown): Record<string, unknown> {
	let updates = input;
	if (isPlainObject(input) && Object.prototype.hasOwnProperty.call(input, "state_updates")) {
		updates = input.state_updates;
	}
	if (typeof updates === "string") {
		try {
			updates = JSON.parse(updates);
		} catch {
			throw new Error("state 增量必须是合法 JSON");
		}
	}
	if (!isPlainObject(updates)) {
		throw new Error("state 增量必须是对象，例如 { \"state_updates\": { \"step\": 1 } }");
	}
	return updates;
}

export function createStateStore(initial?: unknown): StateStore {
	let state: Record<string, unknown> = isPlainObject(initial) ? { ...initial } : {};

	return {
		get() {
			return state;
		},
		merge(input) {
			const updates = extractStateUpdates(input);
			const before = JSON.stringify(state);
			state = { ...state, ...updates };
			return JSON.stringify(state) !== before;
		},
		reset(next) {
			state = isPlainObject(next) ? { ...next } : {};
		},
	};
}

/** 工具参数的 JSON Schema（pi 的 TSchema 就是普通 JSON Schema 形状） */
const STATE_TOOL_SCHEMA = {
	type: "object",
	properties: {
		state_updates: {
			type: "object",
			description: "Partial state object to merge into the shared UI state. Keys not mentioned are kept as-is.",
			additionalProperties: true,
		},
	},
	required: ["state_updates"],
	additionalProperties: false,
};

export interface StateToolOptions {
	store: StateStore;
	/** 状态真的变了才回调，参数是合并后的完整状态 */
	onChanged: (snapshot: Record<string, unknown>) => void;
}

export function createStateTool(options: StateToolOptions): PiAgentTool {
	return {
		name: STATE_TOOL_NAME,
		label: "Update UI state",
		description:
			"Update the shared UI state that the frontend renders. Send only the keys you want to change; they are merged into the existing state. Use this for todos, progress trackers, form values, or any structured data the user should see update live.",
		promptSnippet: `${STATE_TOOL_NAME}: merge a partial object into the shared UI state the user is looking at`,
		promptGuidelines: ["Use this whenever the user should see structured progress (todos, steps, counters) instead of a wall of text."],
		parameters: STATE_TOOL_SCHEMA as never,
		execute: async (_toolCallId: string, params: unknown) => {
			const changed = options.store.merge(params);
			if (changed) options.onChanged(options.store.get());
			return {
				content: [{ type: "text" as const, text: changed ? "UI state updated." : "UI state already matched; nothing changed." }],
				details: { changed },
			};
		},
	} as unknown as PiAgentTool;
}
