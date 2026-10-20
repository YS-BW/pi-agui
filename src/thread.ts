import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ToolDefinition,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { FileBindingStore } from "./bindings.ts";
import { buildContext, toPiToolResultContent } from "./input.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventType, type BaseEvent, type Message, type RunAgentInput, type ToolMessage } from "@ag-ui/core";

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
	/** Original Pi session id from a trusted thread binding. */
	sessionId?: string;
	agentDir?: string;
	/** Trusted host configuration; never read from forwardedProps. */
	sessionOptions?: Omit<CreateAgentSessionOptions, "cwd" | "agentDir" | "resourceLoader">;
	/** Customize the loader without losing the adapter's inline extension. */
	loaderOptions?: Partial<ConstructorParameters<typeof DefaultResourceLoader>[0]>;
}

/** 把 pi 的 transcript 转成 AG-UI 的 Message[]（用于历史回放与 MESSAGES_SNAPSHOT） */
export function toAguiMessages(messages: readonly any[]): Message[] {
	const out: Message[] = [];
	messages.forEach((message, index) => {
		const id = `hist_${index}`;
		switch (message?.role) {
			case "user": {
				const parts = Array.isArray(message.content) ? message.content : [];
				const content =
					typeof message.content === "string"
						? message.content
						: parts.some((part: any) => part.type === "image")
							? parts
									.filter((part: any) => part.type === "text" || part.type === "image")
									.map((part: any) =>
										part.type === "text"
											? { type: "text", text: part.text }
											: {
													type: "image",
													source: {
														type: "data",
														value: part.data,
														mimeType: part.mimeType,
													},
												},
									)
							: parts
									.filter((part: any) => part.type === "text")
									.map((part: any) => part.text)
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
						function: {
							name: String(part.name),
							arguments: JSON.stringify(part.arguments ?? {}),
						},
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
					...(message.isError ? { error: content || "Tool execution failed" } : {}),
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

	private runInput: Partial<RunAgentInput> | undefined;
	private readonly pendingFrontend = new Map<string, string>();
	private readonly frontendResults = new Map<string, ToolMessage>();
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
		let threadRef: Thread | null = null;

		const sessionDir = agentDir ? join(agentDir, "sessions", createHash("sha256").update(cwd).digest("hex")) : undefined;
		let sessionManager: SessionManager | undefined;
		if (threadId && !options.sessionOptions?.sessionManager) {
			const path = SessionManager.findById(cwd, options.sessionId ?? threadId, sessionDir);
			if (path) sessionManager = SessionManager.open(path, undefined, cwd);
		}
		sessionManager = options.sessionOptions?.sessionManager ?? sessionManager ?? SessionManager.create(cwd, sessionDir);

		// 用内联扩展抓住 pi API：pi 的工具登记表是私有的，
		// 运行时想往里加工具（前端工具是随 run 变化的）只有这条路。
		let apiHandle: ExtensionAPI | null = null;
		const resourceLoader = new DefaultResourceLoader({
			...options.loaderOptions,
			cwd,
			agentDir: agentDir ?? join(homedir(), ".pi", "agent"),
			extensionFactories: [
				...(options.loaderOptions?.extensionFactories ?? []),
				(pi: ExtensionAPI) => {
					apiHandle = pi;
					pi.on("before_agent_start", (event) => ({
						systemPrompt: event.systemPrompt + "\n\n" + buildContext(threadRef?.runInput, threadRef?.state ?? {}),
					}));
					pi.on("context", (event) => ({
						messages: event.messages.map((message) => {
							if (message.role !== "toolResult") return message;
							const result = threadRef?.frontendResults.get(message.toolCallId);
							if (!result) return message;
							return {
								...message,
								content: toPiToolResultContent(result.content),
								isError: !!result.error,
							};
						}),
					}));
				},
			],
		});
		// 传了自定义 loader 时 createAgentSession 不会替你 reload，必须自己来，否则扩展不会被加载
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			...options.sessionOptions,
			cwd,
			agentDir,
			sessionManager,
			resourceLoader,
		});
		const sessionId = session.sessionManager.getSessionId();
		// 前端没给 id 就退回用 pi 的会话 id，保证至少有个稳定标识
		const id = threadId ?? sessionId;

		const bridge = createUiBridge({
			onRequest(request) {
				threadRef?.emit([
					{
						type: EventType.CUSTOM,
						name: "pi.ui_request",
						value: request,
					} as BaseEvent,
				]);
			},
			onNotify(message, type) {
				threadRef?.emit([
					{
						type: EventType.CUSTOM,
						name: "pi.notify",
						value: { message, level: type },
					} as BaseEvent,
				]);
			},
			onStatus(key, text) {
				threadRef?.emit([
					{
						type: EventType.CUSTOM,
						name: "pi.status",
						value: { key, text },
					} as BaseEvent,
				]);
			},
			onWidget(key, lines, placement) {
				// 扩展的 setWidget 改译成 AG-UI 的 ACTIVITY_SNAPSHOT：
				// 前端只要有 activityType 的渲染器就能显示，不依赖自定义 CUSTOM 类型。
				const activity = threadRef?.activeTranslator?.activity("ui.widget", `widget_${key}`, { key, lines, placement }, true);
				threadRef?.emit(
					activity && activity.length > 0
						? activity
						: [
								{
									type: EventType.CUSTOM,
									name: "pi.widget",
									value: { key, lines, placement },
								} as BaseEvent,
							],
				);
			},
		});
		const thread = new Thread(id, sessionId, cwd, session, bridge);
		threadRef = thread;

		// mode 用 "rpc"：pi 里只有 tui / rpc 两种模式会让 ctx.hasUI 为 true，
		// 而扩展只有在 hasUI 时才走交互分支（确认框、选择器）。服务化要的就是这些分支。
		try {
			await session.bindExtensions({ mode: "rpc", uiContext: bridge.context });
		} catch (error) {
			thread.dispose();
			throw error;
		}

		// Loader executes extension factories; binding activates their runtime API.
		thread.piApi = apiHandle;
		const finishTurn = session.agent.finishTurn;
		session.agent.finishTurn = async (turn, signal) => {
			const decision = await finishTurn?.(turn, signal);
			return thread.pendingFrontend.size ? { action: "end" } : decision || undefined;
		};
		// Recover frontend handoffs from Pi's own persisted transcript.
		for (const message of session.messages) {
			if (message.role === "toolResult" && (message.details as any)?.forwardedToClient) {
				thread.pendingFrontend.set(message.toolCallId, message.toolName);
			}
			if (message.role === "custom" && message.customType === "agui.frontend-results") {
				for (const result of (message.details as { results?: ToolMessage[] })?.results ?? []) {
					thread.frontendResults.set(result.toolCallId, result);
					thread.pendingFrontend.delete(result.toolCallId);
				}
			}
		}
		if (process.env.PI_AGUI_DEBUG_TOOLS) console.log(`[pi-agui] 扩展 API：${apiHandle ? "拿到" : "没拿到"}`);

		return thread;
	}

	get busy(): boolean {
		return this.activeRunId !== null;
	}

	get pendingToolCallIds(): string[] {
		return [...this.pendingFrontend.keys()];
	}

	get pendingUiRequests(): number {
		return this.bridge.pendingCount;
	}

	/** 历史消息（AG-UI 形态） */
	messages(): Message[] {
		const messages = toAguiMessages(this.session.state.messages as readonly any[]);
		return messages.flatMap<Message>((message) => {
			if (message.role === "assistant") {
				const toolCalls = message.toolCalls?.filter((call) => call.function.name !== STATE_TOOL_NAME);
				if (!message.content && !toolCalls?.length) return [];
				return [{ ...message, ...(toolCalls?.length ? { toolCalls } : {}) }];
			}
			if (message.role !== "tool") return [message];
			const original = this.session.messages.find((m) => m.role === "toolResult" && m.toolCallId === message.toolCallId);
			if (original?.role === "toolResult" && original.toolName === STATE_TOOL_NAME) return [];
			if (this.pendingFrontend.has(message.toolCallId)) return [];
			return [
				{
					...message,
					...this.frontendResults.get(message.toolCallId),
					id: message.id,
				},
			];
		});
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
		return this.bridge.resolve(requestId, response);
	}

	/** 发一个 run。同一线程同时只允许一个 run，忙时立刻报错而不是排队。 */
	async run(runId: string, text: string, images?: unknown[], input?: Partial<RunAgentInput>): Promise<void> {
		if (this.disposed) throw new Error("会话已关闭");
		if (this.activeRunId !== null) throw new Error(`该会话正在运行 run ${this.activeRunId}`);
		const results =
			input?.messages?.filter((message): message is ToolMessage => message.role === "tool" && this.pendingFrontend.has(message.toolCallId)) ?? [];
		if (this.pendingFrontend.size && results.length !== this.pendingFrontend.size)
			throw new Error("Submit exactly one result for every pending frontend tool before continuing");
		if (new Set(results.map((r) => r.toolCallId)).size !== results.length) throw new Error("Duplicate frontend tool result");
		if (!text && !images?.length && !results.length) throw new Error("No matching frontend tool result or user input");

		const translator = createTranslator({
			threadId: this.id,
			runId,
			getMessages: () => this.messages(),
			internalTools: [STATE_TOOL_NAME],
			getPendingToolCallIds: () => [...this.pendingFrontend.keys()],
		});
		this.translator = translator;
		this.activeRunId = runId;
		this.emit(translator.start());
		this.emit([this.threadInfoEvent()]);

		try {
			this.runInput = input;
			// 首次 run 记下 pi 的内置工具名，后面只在这个基线上叠加
			if (!this.baseToolNames) this.baseToolNames = this.session.getActiveToolNames();

			// state 以前端为准（它每次都带着自己看到的最新状态过来），
			// 和官方 Claude adapter 一样：run 开始时用 input.state 初始化本轮上下文。
			if (input?.state !== undefined) this.stateStore.reset(input.state);

			// 每个 run 重新拼工具集：前端工具是随 run 变化的，必须跟着换
			const reserved = new Set([
				...this.session
					.getAllTools()
					.map((t) => t.name)
					.filter((name) => !this.registeredTools.has(name)),
				STATE_TOOL_NAME,
			]);
			for (const tool of input?.tools ?? []) if (reserved.has(tool.name)) throw new Error(`Frontend tool conflicts with a backend tool: ${tool.name}`);
			const frontendTools = toFrontendAgentTools(input?.tools, {
				exclude: [STATE_TOOL_NAME],
				onForwarded: (name, _args, id) => {
					this.pendingFrontend.set(id, name);
				},
			});
			const stateTool = createStateTool({
				store: this.stateStore,
				onChanged: (snapshot) => {
					// 状态真的变了才推快照；前端拿到的永远是完整状态，不用自己 patch
					this.emit([{ type: EventType.STATE_SNAPSHOT, snapshot } as BaseEvent]);
				},
			});
			this.syncTools([...frontendTools, stateTool]);

			this.emit([{ type: EventType.STATE_SNAPSHOT, snapshot: this.state }]);
			if (results.length) {
				for (const result of results) {
					this.frontendResults.set(result.toolCallId, result);
					this.pendingFrontend.delete(result.toolCallId);
				}
				await this.session.sendCustomMessage(
					{
						customType: "agui.frontend-results",
						display: false,
						content: "Frontend tools completed. Continue using their returned results:\n" + JSON.stringify(results),
						details: { results },
					},
					{ triggerTurn: !text && !images?.length },
				);
			}
			if (text || images?.length)
				await this.session.prompt(text, {
					images: images as never,
					expandPromptTemplates: true,
				});
			// Pi prompt includes retries; waitForIdle also covers extension-handled inputs.
			await this.session.waitForIdle();
			this.emit(translator.finish());
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emit(translator.error(message));
		} finally {
			// 兜底：哪怕 agent_settled 因为异常没到达，也要把 run 收掉
			if (this.activeRunId === runId) {
				this.activeRunId = null;
				this.translator = null;
				this.runInput = undefined;
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
	 *  1. 每轮注册当前定义，确保同名工具的 schema 与描述同步；
	 *  2. 再把「内置工具 + 本次前端工具 + 状态工具」设为激活集。
	 * pi 只有在工具登记表里的名字才能激活，所以第 1 步不能省。
	 */
	private syncTools(tools: PiAgentTool[]): void {
		const base = this.baseToolNames ?? [];
		const wanted = [...new Set([...base, ...tools.map((tool) => tool.name)])];

		if (this.piApi) {
			for (const tool of tools) {
				this.piApi.registerTool(tool as unknown as ToolDefinition);
				this.registeredTools.add(tool.name);
			}
			this.piApi.setActiveTools(wanted);
			const active = new Set(this.session.getActiveToolNames());
			const missing = tools.filter((tool) => !active.has(tool.name));
			if (missing.length)
				throw new Error(
					`Pi tool policy excludes adapter tools: ${missing.map((t) => t.name).join(", ")}. Use noTools: "builtin" to disable only native tools.`,
				);
		}

		if (process.env.PI_AGUI_DEBUG_TOOLS) {
			console.log(`[pi-agui] 期望工具：${wanted.join(", ")}`);
			console.log(`[pi-agui] 实际激活：${this.session.getActiveToolNames().join(", ")}`);
			console.log(
				`[pi-agui] 已注册：${this.session
					.getAllTools()
					.map((tool) => tool.name)
					.join(", ")}`,
			);
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

		// Session setup and idle notifications are not implicit AG-UI runs.
		if (!this.translator) return;

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
	private readonly opening = new Map<string, Promise<Thread>>();
	private closed = false;
	private readonly bindings: FileBindingStore;

	private readonly defaultCwd: string;

	private readonly options: Omit<OpenThreadOptions, "cwd" | "threadId">;
	constructor(defaultCwd: string, options: Omit<OpenThreadOptions, "cwd" | "threadId"> = {}) {
		this.options = options;
		this.bindings = new FileBindingStore(join(options.agentDir ?? join(homedir(), ".pi", "agent"), "agui-bindings"));
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
		if (this.closed) throw new Error("Thread supervisor is closed");
		if (threadId) {
			const existing = this.threads.get(threadId);
			if (existing) {
				if (cwd && cwd !== existing.cwd) throw new Error("Cannot change the working directory of an existing thread");
				return existing;
			}
			const pending = this.opening.get(threadId);
			if (pending) {
				const thread = await pending;
				if (cwd && cwd !== thread.cwd) throw new Error("Cannot change the working directory of an existing thread");
				return thread;
			}
		}
		const opening = (async () => {
			const binding = threadId ? await this.bindings.load(threadId) : undefined;
			if (binding && cwd && binding.cwd !== cwd) throw new Error("Cannot change the working directory of a saved thread");
			const thread = await Thread.open({
				...this.options,
				cwd: binding?.cwd ?? cwd ?? this.defaultCwd,
				threadId,
				sessionId: binding?.sessionId,
			});
			try {
				await this.bindings.save({
					threadId: thread.id,
					sessionId: thread.sessionId,
					cwd: thread.cwd,
				});
			} catch (error) {
				thread.dispose();
				throw error;
			}
			return thread;
		})()
			.then((thread) => {
				if (this.closed) {
					thread.dispose();
					throw new Error("Thread supervisor is closed");
				}
				this.threads.set(threadId ?? thread.id, thread);
				return thread;
			})
			.finally(() => {
				if (threadId) this.opening.delete(threadId);
			});
		if (threadId) this.opening.set(threadId, opening);
		return opening;
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
		this.closed = true;
		for (const thread of this.threads.values()) thread.dispose();
		this.threads.clear();
	}
}
