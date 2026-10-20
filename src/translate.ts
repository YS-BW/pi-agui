/**
 * pi 事件 → AG-UI 事件 的纯函数翻译层。
 *
 * 设计原则：
 *  1. 纯函数、无 IO、无定时器，可以脱离 pi 单独单测（见 test/translate.test.ts）。
 *  2. 只翻译用户真正会渲染的东西；pi 给不出来的事件（RAW / SUBAGENT_*）不假装支持。
 *  3. pi 的 message 没有 id，所以 id 由本层按顺序生成，保证同一次 run 内稳定。
 *
 * 与 pi 语义对齐的四个关键点：
 *  - RUN_FINISHED 绑 pi 的 `agent_settled`，不是 `agent_end`：
 *    agent_end 之后 pi 还可能自动重试或压缩重跑，提前收尾会让前端以为结束了。
 *  - TOOL_CALL_START 必须带 parentMessageId：AG-UI 用它把工具调用挂到助手消息上，
 *    而 pi 的 tool_execution_* 只有 toolCallId，没有所属消息，所以本层记着上一条助手消息。
 *  - 推理签名（Anthropic 的 thinking signature / OpenAI 的 encrypted_content）pi 存在
 *    `ThinkingContent.thinkingSignature`，必须原样回传给前端，否则多轮会丢上一轮怎么想的。
 *  - 每次 run 结束前发 MESSAGES_SNAPSHOT：pi 会压缩上下文，压缩后真实历史比前端持有的短，
 *    不发快照前端就会显示已经不在上下文里的旧消息。
 */

import { PROTOCOL_VERSION, EventType, type BaseEvent, type Message } from "@ag-ui/core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** 工具结果被「转交给客户端执行」时的占位文本，CopilotKit 靠这个字符串识别 */
export const FORWARDED_TO_CLIENT = "Forwarded to client";

export interface TranslatorOptions {
	/** AG-UI 会话 id（对应 pi 的 sessionId） */
	threadId: string;
	/** 本次 run 的 id */
	runId: string;
	/** 是否把 thinking 增量翻成 REASONING_* 事件，默认开启 */
	includeReasoning?: boolean;
	/** 单条工具结果的最大字符数，超出截断（默认 10 万） */
	maxToolResultChars?: number;
	/**
	 * 收尾时用来发 MESSAGES_SNAPSHOT 的权威消息列表。
	 * 不提供就不发（比如纯翻译单测场景）。
	 */
	getMessages?: () => Message[];
	/**
	 * 内部工具：不进 AG-UI 的工具调用事件流，只保留副作用。
	 * 例如 `ag_ui_update_state` —— 前端只应该看到状态变化，不该看到这个工具本身。
	 */
	internalTools?: Iterable<string>;
	getPendingToolCallIds?: () => string[];
}

export interface Translator {
	/** run 开始时调用一次，产出 RUN_STARTED */
	start(): BaseEvent[];
	finish(aborted?: boolean): BaseEvent[];
	/** 塞进一个 pi 事件，产出 0..n 个 AG-UI 事件 */
	translate(event: AgentSessionEvent): BaseEvent[];
	/** 收尾：补齐所有未关闭的块（文本 / 推理 / 工具调用） + MESSAGES_SNAPSHOT */
	close(): BaseEvent[];
	/** 中途出错时用：先 close() 再 RUN_ERROR */
	error(message: string): BaseEvent[];
	/** 外部主动推一块活动内容（扩展的 setWidget 之类），产出 ACTIVITY_SNAPSHOT */
	activity(activityType: string, key: string, content: Record<string, unknown>, replace?: boolean): BaseEvent[];
}

/** 把工具返回值压成一段可读文本 */
export function stringifyToolResult(result: unknown, maxChars: number): string {
	const pick = (v: unknown): string => {
		if (typeof v === "string") return v;
		if (v === undefined || v === null) return "";
		if (Array.isArray(v)) {
			// pi 的工具结果是 { content: [{type:"text", text}], details } 这种形状
			const texts = v
				.map((part) =>
					part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "",
				)
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

/** 从流式 partial 消息里取出 contentIndex 位置上的工具调用（还没成型时可能没有 id/name） */
function toolCallAt(partial: unknown, contentIndex: number): { id?: string; name?: string; thoughtSignature?: string } | null {
	const content = (partial as { content?: unknown })?.content;
	if (!Array.isArray(content)) return null;
	const block = content[contentIndex];
	if (!block || typeof block !== "object") return null;
	const call = block as {
		type?: string;
		id?: unknown;
		name?: unknown;
		thoughtSignature?: unknown;
	};
	if (call.type !== "toolCall") return null;
	return {
		id: typeof call.id === "string" && call.id ? call.id : undefined,
		name: typeof call.name === "string" && call.name ? call.name : undefined,
		thoughtSignature: typeof call.thoughtSignature === "string" ? call.thoughtSignature : undefined,
	};
}

/** pi 的 Usage 桶 → AG-UI 的 TokenUsage（字段名不同，语义一一对应） */
function toTokenUsage(bucket: {
	provider: string;
	model: string;
	input: number;
	output: number;
	total: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}) {
	return {
		provider: bucket.provider || undefined,
		model: bucket.model || undefined,
		inputTokens: bucket.input,
		outputTokens: bucket.output,
		totalTokens: bucket.total || bucket.input + bucket.output,
		reasoningTokens: bucket.reasoning,
		cachedInputTokens: bucket.cacheRead,
		cacheWriteInputTokens: bucket.cacheWrite,
	};
}

export function createTranslator(options: TranslatorOptions): Translator {
	const { threadId, runId } = options;
	const includeReasoning = options.includeReasoning ?? true;
	const maxToolResultChars = options.maxToolResultChars ?? 100_000;

	let counter = 0;
	const mint = (prefix: string) => `${runId}_${prefix}_${++counter}`;

	const internalTools = new Set(options.internalTools ?? []);

	let started = false;
	let finished = false;
	let snapshotSent = false;
	let lastError: string | undefined;
	const reasoningIds = new Map<number, string>();
	const toolArgs = new Map<string, string>();
	const bufferedToolArgs = new Map<number, string>();
	let stepCounter = 0;
	let stepOpen = false;
	/** 上一条助手消息在本层的 id */
	let assistantMessageId: string | null = null;
	/** 正在流式输出的文本消息 id */
	let textMessageId: string | null = null;
	/** 当前这条助手消息是否已经开过 TEXT_MESSAGE_START */
	let textMessageOpened = false;
	/** 当前文本块已经推给前端的字符数，用来在 text_end 时补齐没走 delta 的部分 */
	let textSentChars = 0;
	/** 正在流式输出的推理消息 id */
	let reasoningMessageId: string | null = null;
	/** 已打开、尚未结束的工具调用 */
	const openToolCalls = new Set<string>();
	/** 已经通过 toolcall_start/delta 流式发过 START+ARGS 的调用，execution_start 时要跳过 */
	const streamedToolCalls = new Set<string>();
	/** 已经发过 ACTIVITY_SNAPSHOT 的活动 key，用于判断要不要先 replace */
	const activities = new Set<string>();
	/** bash 实时输出流：key → 已发出的分片（用来做 ACTIVITY_DELTA 的增量补丁） */
	const bashStreams = new Map<string, { messageId: string; chunks: string[] }>();
	/** 本次 run 的 token 用量，按 provider/model 分桶 */
	const usageBuckets = new Map<
		string,
		{
			provider: string;
			model: string;
			input: number;
			output: number;
			total: number;
			reasoning: number;
			cacheRead: number;
			cacheWrite: number;
		}
	>();

	const closeReasoning = (out: BaseEvent[]) => {
		if (reasoningMessageId === null) return;
		out.push({
			type: EventType.REASONING_MESSAGE_END,
			messageId: reasoningMessageId,
		});
		out.push({ type: EventType.REASONING_END, messageId: reasoningMessageId });
		reasoningMessageId = null;
	};

	/**
	 * 开一个推理块。
	 * 注意 pi 的 redacted thinking 在 `thinking_start` 就已完整、不会再有 delta 事件，
	 * 所以开块必须在 start 时就做，不能等到第一个 delta。
	 */
	const openReasoning = (out: BaseEvent[]) => {
		if (reasoningMessageId !== null) return reasoningMessageId;
		closeText(out);
		reasoningMessageId = mint("rsn");
		out.push({
			type: EventType.REASONING_START,
			messageId: reasoningMessageId,
		});
		out.push({
			type: EventType.REASONING_MESSAGE_START,
			messageId: reasoningMessageId,
			role: "reasoning",
		});
		return reasoningMessageId;
	};

	const openText = (out: BaseEvent[]): string => {
		if (textMessageId !== null) return textMessageId;
		textMessageId = textMessageOpened ? mint("msg") : (assistantMessageId ?? mint("msg"));
		assistantMessageId = textMessageId;
		textMessageOpened = true;
		closeReasoning(out);
		out.push({
			type: EventType.TEXT_MESSAGE_START,
			messageId: textMessageId,
			role: "assistant",
		});
		return textMessageId;
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
		out.push({
			type: EventType.TEXT_MESSAGE_START,
			messageId: id,
			role: "assistant",
		});
		out.push({ type: EventType.TEXT_MESSAGE_END, messageId: id });
		return id;
	};

	return {
		start() {
			if (started) return [];
			started = true;
			return [
				{
					type: EventType.RUN_STARTED,
					threadId,
					runId,
					protocolVersion: PROTOCOL_VERSION,
				},
			];
		},

		translate(event) {
			if (finished) return [];
			const out: BaseEvent[] = [];
			switch (event.type) {
				case "agent_start":
					// RUN_STARTED 已由 start() 发出，这里不重复
					return out;

				case "turn_start": {
					stepCounter += 1;
					stepOpen = true;
					out.push({
						type: EventType.STEP_STARTED,
						stepName: `turn-${stepCounter}`,
					});
					return out;
				}

				case "turn_end": {
					closeText(out);
					closeReasoning(out);
					if (stepOpen) {
						stepOpen = false;
						out.push({
							type: EventType.STEP_FINISHED,
							stepName: `turn-${stepCounter}`,
						});
					}
					return out;
				}

				case "message_start": {
					if (event.message.role === "assistant") {
						assistantMessageId = mint("msg");
						textMessageOpened = false;
						textSentChars = 0;
						reasoningIds.clear();
						bufferedToolArgs.clear();
						lastError = undefined;
					}
					return out;
				}

				case "message_update": {
					const inner = event.assistantMessageEvent;
					if (inner.type === "text_start") {
						// 新文本块：重置计数，块本身仍然等 message_end 才关
						openText(out);
						textSentChars = 0;
						return out;
					}
					if (inner.type === "text_delta") {
						const messageId = openText(out);
						textSentChars += inner.delta.length;
						out.push({
							type: EventType.TEXT_MESSAGE_CONTENT,
							messageId,
							delta: inner.delta,
						});
						return out;
					}
					if (inner.type === "text_end") {
						// 有些 provider 不吐 delta，只在 text_end 给全文；
						// 这里按「已发字符数」补差值，保证文本不丢也不重复。
						const messageId = openText(out);
						const rest = inner.content.slice(textSentChars);
						if (rest.length > 0) {
							textSentChars = inner.content.length;
							out.push({
								type: EventType.TEXT_MESSAGE_CONTENT,
								messageId,
								delta: rest,
							});
						}
						return out;
					}
					if (includeReasoning && inner.type === "thinking_start") {
						// redacted thinking 只有 start/end、没有 delta，必须在这里就把块开出来
						reasoningIds.set(inner.contentIndex, openReasoning(out));
						return out;
					}
					if (includeReasoning && inner.type === "thinking_delta") {
						const messageId = openReasoning(out);
						reasoningIds.set(inner.contentIndex, messageId);
						out.push({
							type: EventType.REASONING_MESSAGE_CONTENT,
							messageId,
							delta: inner.delta,
						});
						return out;
					}
					if (inner.type === "thinking_end") {
						closeReasoning(out);
					}
					// 工具调用也是流式的：provider 一边生成 JSON 参数一边吐 delta。
					// 在这里就发 TOOL_CALL_START/ARGS，前端能更早看到调用；
					// 等 tool_execution_start 才发的话参数已经全了，看不到渐进。
					if (inner.type === "toolcall_start" || inner.type === "toolcall_delta") {
						if (inner.type === "toolcall_delta")
							bufferedToolArgs.set(inner.contentIndex, (bufferedToolArgs.get(inner.contentIndex) ?? "") + inner.delta);
						const call = toolCallAt(inner.partial, inner.contentIndex);
						// id / name 缺一个就不流式发，交给后面的 tool_execution_start 兜底
						if (!call?.id || !call.name) return out;
						if (internalTools.has(call.name)) return out;
						if (!streamedToolCalls.has(call.id)) {
							closeText(out);
							closeReasoning(out);
							const parentMessageId = ensureParentMessage(out);
							openToolCalls.add(call.id);
							streamedToolCalls.add(call.id);
							activities.delete(`tool:${call.id}`);
							out.push({
								type: EventType.TOOL_CALL_START,
								toolCallId: call.id,
								toolCallName: call.name,
								parentMessageId,
							});
							const buffered = bufferedToolArgs.get(inner.contentIndex);
							if (buffered) {
								toolArgs.set(call.id, buffered);
								out.push({
									type: EventType.TOOL_CALL_ARGS,
									toolCallId: call.id,
									delta: buffered,
								});
							}
							return out;
						}
						if (inner.type === "toolcall_delta" && inner.delta) {
							toolArgs.set(call.id, (toolArgs.get(call.id) ?? "") + inner.delta);
							out.push({
								type: EventType.TOOL_CALL_ARGS,
								toolCallId: call.id,
								delta: inner.delta,
							});
						}
						return out;
					}
					if (inner.type === "toolcall_end") {
						// 工具调用级别的推理签名（Gemini function-call thought signature 等），
						// AG-UI 用 subtype "tool-call" + entityId=toolCallId 表达。
						const call = inner.toolCall;
						if (internalTools.has(call.name)) return out;
						if (!streamedToolCalls.has(call.id)) {
							out.push({
								type: EventType.TOOL_CALL_START,
								toolCallId: call.id,
								toolCallName: call.name,
								parentMessageId: ensureParentMessage(out),
							});
							streamedToolCalls.add(call.id);
						}
						if (!toolArgs.get(call.id))
							out.push({
								type: EventType.TOOL_CALL_ARGS,
								toolCallId: call.id,
								delta: JSON.stringify(call.arguments ?? {}),
							});
						out.push({ type: EventType.TOOL_CALL_END, toolCallId: call.id });
						openToolCalls.delete(call.id);
						if (includeReasoning && call?.thoughtSignature) {
							out.push({
								type: EventType.REASONING_ENCRYPTED_VALUE,
								subtype: "tool-call",
								entityId: String(call.id),
								encryptedValue: call.thoughtSignature,
							});
						}
						return out;
					}
					return out;
				}

				case "message_end": {
					if (event.message.role !== "assistant") return out;
					if (event.message.stopReason === "error") lastError = event.message.errorMessage || "Model request failed";
					const reasoningId = reasoningMessageId;
					closeText(out);
					closeReasoning(out);

					// pi 的 AssistantMessage.usage 是权威 token 账本；
					// AG-UI 的 RUN_FINISHED.usage 正好要这个形状，按 provider/model 分桶累计。
					const assistant = event.message as {
						role?: string;
						provider?: string;
						model?: string;
						usage?: {
							input?: number;
							output?: number;
							totalTokens?: number;
							reasoning?: number;
							cacheRead?: number;
							cacheWrite?: number;
						};
					};
					if (assistant.role === "assistant" && assistant.usage) {
						const provider = assistant.provider ?? "";
						const model = assistant.model ?? "";
						const key = `${provider}\u0000${model}`;
						const bucket = usageBuckets.get(key) ?? {
							provider,
							model,
							input: 0,
							output: 0,
							total: 0,
							reasoning: 0,
							cacheRead: 0,
							cacheWrite: 0,
						};
						bucket.input += assistant.usage.input ?? 0;
						bucket.output += assistant.usage.output ?? 0;
						bucket.total += assistant.usage.totalTokens ?? 0;
						bucket.reasoning += assistant.usage.reasoning ?? 0;
						bucket.cacheRead += assistant.usage.cacheRead ?? 0;
						bucket.cacheWrite += assistant.usage.cacheWrite ?? 0;
						usageBuckets.set(key, bucket);
					}

					// 推理签名（Anthropic thinking signature / OpenAI encrypted_content）
					// 必须在 REASONING_END 之后发，前端才会把它和这条消息关联上。
					if (includeReasoning) {
						for (const [index, block] of (event.message.content ?? []).entries()) {
							if (block.type !== "thinking" || !block.thinkingSignature) continue;
							out.push({
								type: EventType.REASONING_ENCRYPTED_VALUE,
								subtype: "message",
								entityId: reasoningIds.get(index) ?? reasoningId ?? assistantMessageId ?? mint("msg"),
								encryptedValue: block.thinkingSignature,
							});
						}
					}
					return out;
				}

				case "tool_execution_start": {
					if (internalTools.has(event.toolName)) {
						// 内部工具：不暴露给前端，但它是真实执行过的（状态已被改掉）
						openToolCalls.delete(event.toolCallId);
						streamedToolCalls.delete(event.toolCallId);
						return out;
					}
					if (streamedToolCalls.has(event.toolCallId)) {
						// START 和 ARGS 在 message_update 里已经流式发过了，这里只等执行结果
						activities.delete(`tool:${event.toolCallId}`);
						return out;
					}
					closeText(out);
					closeReasoning(out);
					const parentMessageId = ensureParentMessage(out);
					openToolCalls.add(event.toolCallId);
					activities.delete(`tool:${event.toolCallId}`);
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

				case "tool_execution_update": {
					// 工具执行途中的增量输出。AG-UI 没有「部分工具结果」事件，
					// 但 ACTIVITY_* 正好是干这个的：一块持续更新的内容。
					if (internalTools.has(event.toolName)) return out;
					const messageId = `act_tool_${event.toolCallId}`;
					activities.add(`tool:${event.toolCallId}`);
					// pi 的 bash / grep 等工具 onUpdate 推的是「到目前为止的完整输出快照」
					// （节流过，不是增量），所以这里必须用 replace 语义而不是 patch。
					const details = (event.partialResult as { details?: { truncation?: unknown; fullOutputPath?: unknown } } | undefined)?.details;
					out.push({
						type: EventType.ACTIVITY_SNAPSHOT,
						messageId,
						activityType: "tool.progress",
						content: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							partial: stringifyToolResult(event.partialResult, 4000),
							truncation: details?.truncation,
							fullOutputPath: details?.fullOutputPath,
						},
						replace: true,
					});
					return out;
				}

				case "tool_execution_end": {
					streamedToolCalls.delete(event.toolCallId);
					if (internalTools.has(event.toolName)) return out;
					const wasOpen = openToolCalls.delete(event.toolCallId);
					if (wasOpen) {
						out.push({
							type: EventType.TOOL_CALL_END,
							toolCallId: event.toolCallId,
						});
					}
					if (activities.delete(`tool:${event.toolCallId}`)) {
						// 进度块收尾：把最后的内容固化成最终结果
						out.push({
							type: EventType.ACTIVITY_SNAPSHOT,
							messageId: `act_tool_${event.toolCallId}`,
							activityType: "tool.progress",
							content: {
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								done: true,
								isError: event.isError === true,
								// pi 用单调时钟量的耗时，AG-UI 没有对应字段，放进活动块最合适
								durationMs: event.durationMs,
								partial: stringifyToolResult(event.result, 4000),
							},
							replace: true,
						});
					}
					if ((event.result as { details?: { forwardedToClient?: boolean } })?.details?.forwardedToClient) return out;
					out.push({
						type: EventType.TOOL_CALL_RESULT,
						messageId: mint("tool"),
						toolCallId: event.toolCallId,
						content: stringifyToolResult(event.result, maxToolResultChars),
						role: "tool",
						// AG-UI 的 TOOL_CALL_RESULT 没有 isError 字段，metadata 是协议留的扩展位
						...(event.isError ? { metadata: { isError: true } } : {}),
					});
					return out;
				}

				case "agent_end":
					// 不用它收尾：pi 之后可能自动重试或压缩重跑，等 agent_settled
					return out;

				case "agent_settled":
					return this.finish(event.aborted);

				case "compaction_start":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.compaction",
						value: { phase: "start", reason: event.reason },
					});
					return out;

				case "compaction_end": {
					out.push({
						type: EventType.CUSTOM,
						name: "pi.compaction",
						value: {
							phase: "end",
							reason: event.reason,
							aborted: event.aborted,
							willRetry: event.willRetry,
							errorMessage: event.errorMessage,
						},
					});
					// 压缩改写了历史：立刻给前端一份权威快照，否则界面还挂着已经不存在的旧消息
					const messages = options.getMessages?.();
					if (messages && !event.aborted && event.result) {
						out.push({ type: EventType.MESSAGES_SNAPSHOT, messages });
					}
					return out;
				}

				case "auto_retry_start":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.retry",
						value: {
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						},
					});
					return out;

				case "bash_execution_update": {
					// pi 的 bash 工具会把 stdout 边跑边吐出来（真增量，不是 partial 快照）。
					// AG-UI 的 ACTIVITY_* 就是给这种「不是对话内容、但要实时渲染」的数据用的：
					// 第一片建快照，后面用 RFC 6902 往 chunks 数组尾部 append，不用每次重发全文。
					const key = event.id ?? "bash";
					let stream = bashStreams.get(key);
					if (!stream) {
						stream = { messageId: `act_bash_${key}`, chunks: [] };
						bashStreams.set(key, stream);
					}
					stream.chunks.push(event.delta);
					if (stream.chunks.length === 1) {
						out.push({
							type: EventType.ACTIVITY_SNAPSHOT,
							messageId: stream.messageId,
							activityType: "bash.output",
							content: { toolCallId: key, chunks: [...stream.chunks] },
							replace: true,
						});
					} else {
						out.push({
							type: EventType.ACTIVITY_DELTA,
							messageId: stream.messageId,
							activityType: "bash.output",
							patch: [{ op: "add", path: "/chunks/-", value: event.delta }],
						});
					}
					return out;
				}

				case "thinking_level_changed":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.thinking_level",
						value: { level: event.level },
					});
					return out;

				case "auto_retry_end":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.retry_end",
						value: {
							success: event.success,
							attempt: event.attempt,
							finalError: event.finalError,
						},
					});
					return out;

				case "summarization_retry_scheduled":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.summarization_retry",
						value: {
							phase: "scheduled",
							attempt: event.attempt,
							maxAttempts: event.maxAttempts,
							delayMs: event.delayMs,
							errorMessage: event.errorMessage,
						},
					});
					return out;

				case "summarization_retry_attempt_start":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.summarization_retry",
						value: { phase: "start", source: event.source },
					});
					return out;

				case "summarization_retry_finished":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.summarization_retry",
						value: { phase: "finished" },
					});
					return out;

				case "queue_update":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.queue",
						value: {
							steering: [...event.steering],
							followUp: [...event.followUp],
						},
					});
					return out;

				case "session_info_changed":
					out.push({
						type: EventType.CUSTOM,
						name: "pi.session_info",
						value: { name: event.name },
					});
					return out;

				default:
					return out;
			}
		},

		finish(aborted = false) {
			if (finished) return [];
			if (lastError && !aborted) return this.error(lastError);
			finished = true;
			const pendingToolCallIds = options.getPendingToolCallIds?.() ?? [];
			return [
				...this.close(),
				{
					type: EventType.RUN_FINISHED,
					threadId,
					runId,
					...(aborted ? { outcome: { type: "cancelled" } } : pendingToolCallIds.length ? { outcome: { type: "success", pendingToolCallIds } } : {}),
					...(usageBuckets.size ? { usage: [...usageBuckets.values()].map(toTokenUsage) } : {}),
				},
			];
		},

		activity(activityType, key, content, replace = true) {
			const messageId = `act_${key}`;
			if (!started || finished) return [];
			if (activities.has(`act:${key}`) && replace === false) {
				// 增量由调用方自己拼 patch，这里只负责发
			}
			activities.add(`act:${key}`);
			return [
				{
					type: EventType.ACTIVITY_SNAPSHOT,
					messageId,
					activityType,
					content,
					replace,
				},
			];
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
				out.push({
					type: EventType.STEP_FINISHED,
					stepName: `turn-${stepCounter}`,
				});
			}

			// 官方 Claude adapter 也是每次 run 结束前发一次 MESSAGES_SNAPSHOT。
			// 它是唯一能让前端和 pi 真实上下文对齐的事件（压缩/重试之后尤其重要）。
			const messages = options.getMessages?.();
			if (messages && !snapshotSent) {
				snapshotSent = true;
				out.push({ type: EventType.MESSAGES_SNAPSHOT, messages });
			}
			return out;
		},

		error(message) {
			if (finished) return [];
			finished = true;
			const out = this.close();
			out.push({
				type: EventType.RUN_ERROR,
				threadId,
				runId,
				message,
				// 失败的 run 也已经烧了 token，账要照报
				...(usageBuckets.size > 0 ? { usage: [...usageBuckets.values()].map(toTokenUsage) } : {}),
			});
			return out;
		},
	};
}
