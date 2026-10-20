/**
 * Thread：一条 AG-UI 会话 = 一个 pi AgentSession。
 *
 * threadId 直接用 pi 自己的 sessionId，这样：
 *  - 前端传回来的 threadId 能直接用来 findById 恢复会话，不用维护映射表；
 *  - 会话文件名、jsonl 内容、AG-UI 会话三者天然一致，排查问题只看一套 id。
 */

import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";

import { createTranslator, type Translator } from "./translate.ts";
import { createUiBridge, type UiBridge, type UiResponse } from "./ui-context.ts";
import { createStateStore, createStateTool, STATE_TOOL_NAME, type PiAgentTool, type StateStore } from "./state.ts";
import { toFrontendAgentTools } from "./frontend-tools.ts";

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
	/** AG-UI 共享状态（STATE_*） */
	private readonly stateStore: StateStore = createStateStore();
	/** 首次 run 时抓到的 pi 内置工具名，之后每次 run 都在这个基础上拼 */
	private baseToolNames: string[] | null = null;
	/** 通过内联扩展拿到的 pi API，用来在运行时注册工具 */
	private piApi: ExtensionAPI | null = null;
	/** 已经注册进 pi 工具登记表的工具名，避免重复注册 */
	private readonly registeredTools = new Set<string>();
	/** 上次生效的工具名集合，相同就不重复重建 system prompt */
	private activeToolNames: string[] | null = null;

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

		// 用内联扩展抓住 pi API：pi 的工具登记表是私有的，
		// 运行时想往里加工具（前端工具是随 run 变化的）只有这条路。
		let apiHandle: ExtensionAPI | null = null;
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: agentDir ?? join(homedir(), ".pi", "agent"),
			extensionFactories: [(pi: ExtensionAPI) => { apiHandle = pi; }],
		});
		// 传了自定义 loader 时 createAgentSession 不会替你 reload，必须自己来，否则扩展不会被加载
		await resourceLoader.reload();

		const { session } = await createAgentSession({ cwd, agentDir, sessionManager, resourceLoader });
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
				// 扩展的 setWidget 改译成 AG-UI 的 ACTIVITY_SNAPSHOT：
				// 前端只要有 activityType 的渲染器就能显示，不依赖自定义 CUSTOM 类型。
				const activity = threadRef?.activeTranslator?.activity("ui.widget", `widget_${key}`, { key, lines, placement }, true);
				threadRef?.emit(
					activity && activity.length > 0
						? activity
						: [{ type: EventType.CUSTOM, name: "pi.widget", value: { key, lines, placement } } as BaseEvent],
				);
			},
		});
		const thread = new Thread(id, sessionId, cwd, session, bridge);
		threadRef = thread;

		// mode 用 "rpc"：pi 里只有 tui / rpc 两种模式会让 ctx.hasUI 为 true，
		// 而扩展只有在 hasUI 时才走交互分支（确认框、选择器）。服务化要的就是这些分支。
		await session.bindExtensions({ mode: "rpc", uiContext: bridge.context });

		// 扩展工厂是在 bindExtensions 里跑的，所以这里才拿得到 pi API
		thread.piApi = apiHandle;
		if (process.env.PI_AGUI_DEBUG_TOOLS) console.log(`[pi-agui] 扩展 API：${apiHandle ? "拿到" : "没拿到"}`);

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

	/** 当前共享状态（STATE_SNAPSHOT 的载荷） */
	get state(): Record<string, unknown> {
		return this.stateStore.get();
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
	async run(runId: string, text: string, images?: unknown[], input?: Partial<RunAgentInput>): Promise<void> {
		if (this.disposed) throw new Error("会话已关闭");
		if (this.activeRunId !== null) {
			const translator = createTranslator({ threadId: this.id, runId });
			this.emit(translator.start());
			this.emit(translator.error(`该会话正在运行 run ${this.activeRunId}，请等它结束后再发消息`));
			return;
		}

		const translator = createTranslator({
			threadId: this.id,
			runId,
			getMessages: () => this.messages(),
			internalTools: [STATE_TOOL_NAME],
		});
		this.translator = translator;
		this.activeRunId = runId;
		this.emit(translator.start());
		this.emit([this.threadInfoEvent()]);

		// 首次 run 记下 pi 的内置工具名，后面只在这个基线上叠加
		if (!this.baseToolNames) this.baseToolNames = this.session.getActiveToolNames();

		// state 以前端为准（它每次都带着自己看到的最新状态过来），
		// 和官方 Claude adapter 一样：run 开始时用 input.state 初始化本轮上下文。
		if (input?.state !== undefined) this.stateStore.reset(input.state);

		// 每个 run 重新拼工具集：前端工具是随 run 变化的，必须跟着换
		const frontendTools = toFrontendAgentTools(input?.tools, { exclude: [STATE_TOOL_NAME] });
		const stateTool = createStateTool({
			store: this.stateStore,
			onChanged: (snapshot) => {
				// 状态真的变了才推快照；前端拿到的永远是完整状态，不用自己 patch
				this.emit([{ type: EventType.STATE_SNAPSHOT, snapshot } as BaseEvent]);
			},
		});
		this.syncTools([...frontendTools, stateTool]);

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

	/**
	 * 把本次 run 需要的工具同步进 pi：
	 *  1. 没注册过的先注册（前端工具的 execute 都是回占位符，注册一次就能反复用）；
	 *  2. 再把「内置工具 + 本次前端工具 + 状态工具」设为激活集。
	 * pi 只有在工具登记表里的名字才能激活，所以第 1 步不能省。
	 */
	private syncTools(tools: PiAgentTool[]): void {
		const base = this.baseToolNames ?? [];
		const wanted = [...new Set([...base, ...tools.map((tool) => tool.name)])];

		const unchanged =
			this.activeToolNames !== null &&
			this.activeToolNames.length === wanted.length &&
			wanted.every((name) => this.activeToolNames!.includes(name));
		if (unchanged) return;

		if (this.piApi) {
			for (const tool of tools) {
				if (this.registeredTools.has(tool.name)) continue;
				this.piApi.registerTool(tool as unknown as ToolDefinition);
				this.registeredTools.add(tool.name);
			}
			this.piApi.setActiveTools(wanted);
		}
		this.activeToolNames = wanted;

		if (process.env.PI_AGUI_DEBUG_TOOLS) {
			console.log(`[pi-agui] 期望工具：${wanted.join(", ")}`);
			console.log(`[pi-agui] 实际激活：${this.session.getActiveToolNames().join(", ")}`);
			console.log(`[pi-agui] 已注册：${this.session.getAllTools().map((tool) => tool.name).join(", ")}`);
		}
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
			const translator = createTranslator({
				threadId: this.id,
				runId,
				getMessages: () => this.messages(),
				internalTools: [STATE_TOOL_NAME],
			});
			this.translator = translator;
			this.activeRunId = runId;
			this.emit(translator.start());
		}

		const translator = this.translator;
		if (!translator) return;
		this.emit(translator.translate(event));
	}

	/** 内部用：拿当前活跃的 translator（widget 回调要把 CUSTOM 换成 ACTIVITY_*） */
	get activeTranslator(): Translator | null {
		return this.translator;
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
