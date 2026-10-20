/**
 * Thread：一条 AG-UI 会话 = 一个 pi AgentSession。
 *
 * threadId 直接用 pi 自己的 sessionId，这样：
 *  - 前端传回来的 threadId 能直接用来 findById 恢复会话，不用维护映射表；
 *  - 会话文件名、jsonl 内容、AG-UI 会话三者天然一致，排查问题只看一套 id。
 */

import {
	SessionManager,
	createAgentSession,
	type AgentSession,
	type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";

import { createTranslator, type Translator } from "./translate.ts";
import { createUiBridge, type UiBridge, type UiResponse } from "./ui-context.ts";

/** 带序号的 AG-UI 事件：前端断线可以用 seq 续传 */
export interface StoredEvent {
	seq: number;
	event: BaseEvent;
}

export type EventListener = (record: StoredEvent) => void;

const MAX_BUFFERED_EVENTS = 2000;

export interface OpenThreadOptions {
	cwd: string;
	/** 想恢复的会话 id；不传或找不到就新建 */
	threadId?: string;
	agentDir?: string;
}

/** 把 pi 的 transcript 转成 AG-UI 的 Message[]（用于历史回放与 MESSAGES_SNAPSHOT） */
export function toAguiMessages(messages: readonly any[]): Message[] {
	const out: Message[] = [];
	messages.forEach((message, index) => {
		const id = `hist_${index}`;
		switch (message?.role) {
			case "user": {
				const content =
					typeof message.content === "string"
						? message.content
						: (message.content ?? [])
								.filter((part: any) => part?.type === "text")
								.map((part: any) => String(part.text ?? ""))
								.join("\n");
				out.push({ id, role: "user", content } as Message);
				break;
			}
			case "assistant": {
				const parts: any[] = Array.isArray(message.content) ? message.content : [];
				const text = parts
					.filter((part) => part?.type === "text")
					.map((part) => String(part.text ?? ""))
					.join("");
				const toolCalls = parts
					.filter((part) => part?.type === "toolCall")
					.map((part) => ({
						id: String(part.id),
						type: "function" as const,
						function: { name: String(part.name), arguments: JSON.stringify(part.arguments ?? {}) },
					}));
				out.push({
					id,
					role: "assistant",
					content: text,
					...(toolCalls.length > 0 ? { toolCalls } : {}),
				} as Message);
				break;
			}
			case "toolResult": {
				const content = (message.content ?? [])
					.filter((part: any) => part?.type === "text")
					.map((part: any) => String(part.text ?? ""))
					.join("\n");
				out.push({
					id,
					role: "tool",
					toolCallId: String(message.toolCallId),
					content,
				} as Message);
				break;
			}
			default:
				// system 之类不发：AG-UI 前端不需要看到系统提示词
				break;
		}
	});
	return out;
}

export class Thread {
	/** AG-UI 侧的会话 id（前端传什么就是什么，回放时要一模一样） */
	readonly id: string;
	/** pi 自己的会话 id，也是 jsonl 文件名的一部分 */
	readonly sessionId: string;
	readonly cwd: string;
	readonly session: AgentSession;

	private readonly bridge: UiBridge;
	private readonly unsubscribe: () => void;
	private readonly listeners = new Set<EventListener>();
	private readonly buffer: StoredEvent[] = [];

	private seq = 0;
	private translator: Translator | null = null;
	private activeRunId: string | null = null;
	private disposed = false;

	private constructor(id: string, sessionId: string, cwd: string, session: AgentSession, bridge: UiBridge) {
		this.id = id;
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.session = session;
		this.bridge = bridge;
		this.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event));
	}

	static async open(options: OpenThreadOptions): Promise<Thread> {
		const { cwd, threadId, agentDir } = options;

		let sessionManager: SessionManager | undefined;
		if (threadId) {
			const path = SessionManager.findById(cwd, threadId);
			if (path) sessionManager = SessionManager.open(path, undefined, cwd);
		}
		sessionManager ??= SessionManager.create(cwd);

		const { session } = await createAgentSession({ cwd, agentDir, sessionManager });
		const sessionId = session.sessionManager.getSessionId();
		// 前端没给 id 就退回用 pi 的会话 id，保证至少有个稳定标识
		const id = threadId ?? sessionId;

		let threadRef: Thread | null = null;

		const bridge = createUiBridge({
			onRequest(request) {
				threadRef?.emit([{ type: EventType.CUSTOM, name: "pi.ui_request", value: request } as BaseEvent]);
			},
			onNotify(message, type) {
				threadRef?.emit([{ type: EventType.CUSTOM, name: "pi.notify", value: { message, level: type } } as BaseEvent]);
			},
			onStatus(key, text) {
				threadRef?.emit([{ type: EventType.CUSTOM, name: "pi.status", value: { key, text } } as BaseEvent]);
			},
			onWidget(key, lines, placement) {
				threadRef?.emit([{ type: EventType.CUSTOM, name: "pi.widget", value: { key, lines, placement } } as BaseEvent]);
			},
		});
		const thread = new Thread(id, sessionId, cwd, session, bridge);
		threadRef = thread;

		// mode 用 "rpc"：pi 里只有 tui / rpc 两种模式会让 ctx.hasUI 为 true，
		// 而扩展只有在 hasUI 时才走交互分支（确认框、选择器）。服务化要的就是这些分支。
		await session.bindExtensions({ mode: "rpc", uiContext: bridge.context });

		return thread;
	}

	get busy(): boolean {
		return this.activeRunId !== null;
	}

	get pendingUiRequests(): number {
		return this.bridge.pendingCount;
	}

	/** 历史消息（AG-UI 形态） */
	messages(): Message[] {
		return toAguiMessages(this.session.state.messages as readonly any[]);
	}

	/** 订阅事件流；返回退订函数 */
	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** 从 after 之后开始补发（断线重连） */
	replay(after: number): StoredEvent[] {
		return this.buffer.filter((record) => record.seq > after);
	}

	/** 前端回填一个挂起的 UI 请求 */
	resolveUiRequest(requestId: string, response: UiResponse): boolean {
		if (this.bridge.pendingCount === 0) return false;
		this.bridge.resolve(requestId, response);
		return true;
	}

	/** 发一个 run。同一线程同时只允许一个 run，忙时立刻报错而不是排队。 */
	async run(runId: string, text: string, images?: unknown[]): Promise<void> {
		if (this.disposed) throw new Error("会话已关闭");
		if (this.activeRunId !== null) {
			const translator = createTranslator({ threadId: this.id, runId });
			this.emit(translator.start());
			this.emit(translator.error(`该会话正在运行 run ${this.activeRunId}，请等它结束后再发消息`));
			return;
		}

		const translator = createTranslator({ threadId: this.id, runId });
		this.translator = translator;
		this.activeRunId = runId;
		this.emit(translator.start());
		this.emit([this.threadInfoEvent()]);

		try {
			await this.session.prompt(text, {
				images: images as never,
				expandPromptTemplates: true,
			});
			// prompt() 只负责把消息送进去，真正跑完要等 agent_settled
			await this.session.waitForIdle();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emit(translator.error(message));
		} finally {
			// 兜底：哪怕 agent_settled 因为异常没到达，也要把 run 收掉
			if (this.activeRunId === runId) {
				this.activeRunId = null;
				this.translator = null;
			}
		}
	}

	async abort(): Promise<void> {
		this.bridge.cancelAll();
		await this.session.abort();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.bridge.cancelAll();
		this.unsubscribe();
		this.listeners.clear();
		this.session.dispose();
	}

	/** 告诉前端 pi 自己的会话 id 和落盘位置，方便它做线程列表 */
	private threadInfoEvent(): BaseEvent {
		return {
			type: EventType.CUSTOM,
			name: "pi.thread",
			value: { threadId: this.id, sessionId: this.sessionId, cwd: this.cwd },
		} as BaseEvent;
	}

	private handleSessionEvent(event: AgentSessionEvent): void {
		if (this.disposed) return;

		// 没有 run 在跑时（例如扩展主动触发的一轮），临时开一个 run 让事件有归属
		if (!this.translator) {
			const runId = `auto_${Date.now().toString(36)}`;
			const translator = createTranslator({ threadId: this.id, runId });
			this.translator = translator;
			this.activeRunId = runId;
			this.emit(translator.start());
		}

		const translator = this.translator;
		if (!translator) return;
		this.emit(translator.translate(event));
	}

	private emit(events: BaseEvent[]): void {
		if (events.length === 0) return;
		for (const event of events) {
			const record: StoredEvent = { seq: ++this.seq, event };
			this.buffer.push(record);
			if (this.buffer.length > MAX_BUFFERED_EVENTS) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
			for (const listener of this.listeners) {
				try {
					listener(record);
				} catch {
					// 单个订阅者炸掉不能影响其他订阅者
				}
			}
		}
	}
}

/** 线程池：按 threadId 复用进程内的 pi 会话 */
export class ThreadSupervisor {
	private readonly threads = new Map<string, Thread>();

	private readonly defaultCwd: string;

	constructor(defaultCwd: string) {
		this.defaultCwd = defaultCwd;
	}

	get defaultWorkingDir(): string {
		return this.defaultCwd;
	}

	get(threadId: string): Thread | undefined {
		return this.threads.get(threadId);
	}

	/** 打开或复用线程 */
	async open(threadId?: string, cwd?: string): Promise<Thread> {
		if (threadId) {
			const existing = this.threads.get(threadId);
			if (existing) return existing;
		}
		const thread = await Thread.open({ cwd: cwd ?? this.defaultCwd, threadId });
		// 用调用方的 key 建索引：前端可能用自造 id，下次还得能命中
		this.threads.set(threadId ?? thread.id, thread);
		return thread;
	}

	/** 当前进程内所有活着的会话 */
	list(): Thread[] {
		return [...new Set(this.threads.values())];
	}

	close(threadId: string): boolean {
		const thread = this.threads.get(threadId);
		if (!thread) return false;
		thread.dispose();
		this.threads.delete(threadId);
		return true;
	}

	closeAll(): void {
		for (const thread of this.threads.values()) thread.dispose();
		this.threads.clear();
	}
}
