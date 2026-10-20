/**
 * pi 事件 → AG-UI 事件 的纯函数翻译层。
 *
 * 设计原则：
 *  1. 纯函数、无 IO、无定时器，可以脱离 pi 单独单测（见 translate.test.ts）。
 *  2. 只翻译用户真正会渲染的东西；AG-UI 的 31 种事件这里只用 12 种，其余原样丢弃。
 *  3. pi 的 message 没有 id，所以 id 由本层按顺序生成，保证同一次 run 内稳定。
 *
 * 与 pi 语义对齐的两个关键点：
 *  - RUN_FINISHED 绑 pi 的 `agent_settled`，不是 `agent_end`：
 *    agent_end 之后 pi 还可能自动重试或压缩重跑，提前收尾会让前端以为结束了。
 *  - TOOL_CALL_START 必须带 parentMessageId：AG-UI 用它把工具调用挂到助手消息上，
 *    而 pi 的 tool_execution_* 只有 toolCallId，没有所属消息，所以本层记着上一条助手消息。
 */

import { EventType, type BaseEvent } from "@ag-ui/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface TranslatorOptions {
	/** AG-UI 会话 id（对应 pi 的 sessionId） */
	threadId: string;
	/** 本次 run 的 id */
	runId: string;
	/** 是否把 thinking 增量翻成 REASONING_* 事件，默认开启 */
	includeReasoning?: boolean;
	/** 单条工具结果的最大字符数，超出截断（默认 10 万） */
	maxToolResultChars?: number;
}

export interface Translator {
	/** run 开始时调用一次，产出 RUN_STARTED */
	start(): BaseEvent[];
	/** 塞进一个 pi 事件，产出 0..n 个 AG-UI 事件 */
	translate(event: AgentSessionEvent): BaseEvent[];
	/** 收尾：补齐所有未关闭的块（文本 / 推理 / 工具调用） */
	close(): BaseEvent[];
	/** 中途出错时用：先 close() 再 RUN_ERROR */
	error(message: string): BaseEvent[];
}

/** 把工具返回值压成一段可读文本 */
export function stringifyToolResult(result: unknown, maxChars: number): string {
	const pick = (v: unknown): string => {
		if (typeof v === "string") return v;
		if (v === undefined || v === null) return "";
		if (Array.isArray(v)) {
			// pi 的工具结果是 { content: [{type:"text", text}], details } 这种形状
			const texts = v
				.map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
				.filter(Boolean);
			if (texts.length > 0) return texts.join("\n");
		}
		if (v && typeof v === "object") {
			const obj = v as { content?: unknown; details?: unknown; text?: unknown };
			if (Array.isArray(obj.content)) {
				const inner = pick(obj.content);
				if (inner) return inner;
			}
			if (typeof obj.text === "string") return obj.text;
			try {
				return JSON.stringify(v);
			} catch {
				return String(v);
			}
		}
		return String(v);
	};

	const text = pick(result);
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n…（已截断，原始长度 ${text.length} 字符）`;
}

export function createTranslator(options: TranslatorOptions): Translator {
	const { threadId, runId } = options;
	const includeReasoning = options.includeReasoning ?? true;
	const maxToolResultChars = options.maxToolResultChars ?? 100_000;

	let counter = 0;
	const mint = (prefix: string) => `${prefix}_${++counter}`;

	let started = false;
	let stepCounter = 0;
	let stepOpen = false;
	/** 上一条助手消息在本层的 id */
	let assistantMessageId: string | null = null;
	/** 正在流式输出的文本消息 id */
	let textMessageId: string | null = null;
	/** 当前这条助手消息是否已经开过 TEXT_MESSAGE_START */
	let textMessageOpened = false;
	/** 正在流式输出的推理消息 id */
	let reasoningMessageId: string | null = null;
	/** 已打开、尚未结束的工具调用 */
	const openToolCalls = new Set<string>();

	const closeReasoning = (out: BaseEvent[]) => {
		if (reasoningMessageId === null) return;
		out.push({ type: EventType.REASONING_MESSAGE_END, messageId: reasoningMessageId });
		out.push({ type: EventType.REASONING_END, messageId: reasoningMessageId });
		reasoningMessageId = null;
	};

	const openText = (out: BaseEvent[]) => {
		if (textMessageId !== null) return;
		textMessageId = assistantMessageId ?? mint("msg");
		assistantMessageId = textMessageId;
		textMessageOpened = true;
		closeReasoning(out);
		out.push({ type: EventType.TEXT_MESSAGE_START, messageId: textMessageId, role: "assistant" });
	};

	const closeText = (out: BaseEvent[]) => {
		if (textMessageId === null) return;
		out.push({ type: EventType.TEXT_MESSAGE_END, messageId: textMessageId });
		textMessageId = null;
	};

	/**
	 * 工具调用必须有爹（AG-UI 用它把调用挂到助手消息上）。
	 * - 文本还开着：就挂在它上面；
	 * - 文本已经关了但消息已经露过面：仍挂回那条消息，不重复开；
	 * - 这条助手消息压根没露过面（纯工具轮）：补一条空消息当容器。
	 */
	const ensureParentMessage = (out: BaseEvent[]): string => {
		if (textMessageId !== null) return textMessageId;
		if (assistantMessageId !== null && textMessageOpened) return assistantMessageId;

		const id = assistantMessageId ?? mint("msg");
		assistantMessageId = id;
		textMessageOpened = true;
		out.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: "assistant" });
		out.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
		return id;
	};

	return {
		start() {
			if (started) return [];
			started = true;
			return [{ type: EventType.RUN_STARTED, threadId, runId }];
		},

		translate(event) {
			const out: BaseEvent[] = [];
			switch (event.type) {
				case "agent_start":
					// RUN_STARTED 已由 start() 发出，这里不重复
					return out;

				case "turn_start": {
					stepCounter += 1;
					stepOpen = true;
					out.push({ type: EventType.STEP_STARTED, stepName: `turn-${stepCounter}` });
					return out;
				}

				case "turn_end": {
					closeText(out);
					closeReasoning(out);
					if (stepOpen) {
						stepOpen = false;
						out.push({ type: EventType.STEP_FINISHED, stepName: `turn-${stepCounter}` });
					}
					return out;
				}

				case "message_start": {
					if (event.message.role === "assistant") {
						assistantMessageId = mint("msg");
						textMessageOpened = false;
					}
					return out;
				}

				case "message_update": {
					const inner = event.assistantMessageEvent;
					if (inner.type === "text_delta") {
						openText(out);
						out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textMessageId!, delta: inner.delta });
						return out;
					}
					if (includeReasoning && inner.type === "thinking_delta") {
						// 推理块和文本块互斥，开新的推理块前先把文本块关掉
						closeText(out);
						if (reasoningMessageId === null) {
							reasoningMessageId = mint("rsn");
							out.push({ type: EventType.REASONING_START, messageId: reasoningMessageId });
							out.push({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningMessageId, role: "reasoning" });
						}
						out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningMessageId, delta: inner.delta });
						return out;
					}
					if (inner.type === "thinking_end") {
						closeReasoning(out);
					}
					return out;
				}

				case "message_end": {
					closeText(out);
					closeReasoning(out);
					return out;
				}

				case "tool_execution_start": {
					closeText(out);
					closeReasoning(out);
					const parentMessageId = ensureParentMessage(out);
					openToolCalls.add(event.toolCallId);
					out.push({
						type: EventType.TOOL_CALL_START,
						toolCallId: event.toolCallId,
						toolCallName: event.toolName,
						parentMessageId,
					});
					out.push({
						type: EventType.TOOL_CALL_ARGS,
						toolCallId: event.toolCallId,
						delta: JSON.stringify(event.args ?? {}),
					});
					return out;
				}

				case "tool_execution_update":
					// 流式工具结果：AG-UI 没有对应的“部分结果”事件，直接丢弃
					return out;

				case "tool_execution_end": {
					const wasOpen = openToolCalls.delete(event.toolCallId);
					if (wasOpen) {
						out.push({ type: EventType.TOOL_CALL_END, toolCallId: event.toolCallId });
					}
					out.push({
						type: EventType.TOOL_CALL_RESULT,
						messageId: mint("tool"),
						toolCallId: event.toolCallId,
						content: stringifyToolResult(event.result, maxToolResultChars),
						role: "tool",
					});
					return out;
				}

				case "agent_end":
					// 不用它收尾：pi 之后可能自动重试或压缩重跑，等 agent_settled
					return out;

				case "agent_settled": {
					out.push(...this.close());
					out.push({ type: EventType.RUN_FINISHED, threadId, runId });
					return out;
				}

				case "compaction_start":
					out.push({ type: EventType.CUSTOM, name: "pi.compaction", value: { phase: "start", reason: event.reason } });
					return out;

				case "compaction_end":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.compaction",
						value: { phase: "end", reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, errorMessage: event.errorMessage },
					});
					return out;

				case "auto_retry_start":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.retry",
						value: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage },
					});
					return out;

				case "queue_update":
					out.push({ type: EventType.CUSTOM, name: "pi.queue", value: { steering: [...event.steering], followUp: [...event.followUp] } });
					return out;

				case "session_info_changed":
					out.push({ type: EventType.CUSTOM, name: "pi.session_info", value: { name: event.name } });
					return out;

				default:
					return out;
			}
		},

		close() {
			const out: BaseEvent[] = [];
			closeText(out);
			closeReasoning(out);
			for (const toolCallId of openToolCalls) {
				out.push({ type: EventType.TOOL_CALL_END, toolCallId });
			}
			openToolCalls.clear();
			if (stepOpen) {
				stepOpen = false;
				out.push({ type: EventType.STEP_FINISHED, stepName: `turn-${stepCounter}` });
			}
			return out;
		},

		error(message) {
			const out = this.close();
			out.push({ type: EventType.RUN_ERROR, message });
			return out;
		},
	};
}
