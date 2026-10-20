/**
 * 把 pi 会话暴露成 AG-UI 服务。
 *
 * 只用 node:http，不引 express：这个服务要做的事情很少（一条 SSE 长连接 + 几个 JSON 接口），
 * 中间件带来的复杂度大于收益。
 *
 * 接口分两类：
 *  - AG-UI 标准面：POST / （HttpAgent 的默认落点）、GET /info
 *  - pi 自己的会话面：/threads 系列，用来列会话、看历史、断线重连、中断
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";

import { Thread, ThreadSupervisor, type StoredEvent } from "./thread.ts";

export interface ServeOptions {
	port: number;
	host?: string;
	/** 默认工作目录，也是 pi 会话的归属目录 */
	cwd: string;
	/** pi 全局配置目录，默认 ~/.pi/agent */
	agentDir?: string;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Last-Event-ID",
	"Access-Control-Expose-Headers": "Content-Type",
};

const encoder = new EventEncoder({ accept: "text/event-stream" });

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS });
	res.end(payload);
}

async function readJson(req: IncomingMessage, limit = 32 * 1024 * 1024): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new Error("请求体过大");
		chunks.push(chunk as Buffer);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	return text.trim() === "" ? {} : JSON.parse(text);
}

/** 打开一条 SSE 连接，返回写事件/收尾的把手 */
function openSse(req: IncomingMessage, res: ServerResponse) {
	res.writeHead(200, {
		"Content-Type": encoder.getContentType(),
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
		...CORS_HEADERS,
	});
	res.flushHeaders?.();

	let closed = false;
	const heartbeat = setInterval(() => {
		if (!closed) res.write(": ping\n\n");
	}, 15_000);
	heartbeat.unref?.();

	req.on("close", () => {
		closed = true;
		clearInterval(heartbeat);
	});

	return {
		get closed() {
			return closed;
		},
		write(event: BaseEvent) {
			if (closed) return;
			res.write(encoder.encodeSSE(event));
		},
		/** 回放接口用：自带 id，支持 Last-Event-ID 续传 */
		writeSequenced(record: StoredEvent) {
			if (closed) return;
			res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record.event)}\n\n`);
		},
		end() {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			res.end();
		},
	};
}

/** 从 RunAgentInput 里取出最后一条用户消息 */
function extractUserInput(input: RunAgentInput): { text: string; images: unknown[] } {
	const messages = (input.messages ?? []) as any[];
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;

		const content = message.content;
		if (typeof content === "string") return { text: content, images: [] };
		if (!Array.isArray(content)) return { text: "", images: [] };

		const texts: string[] = [];
		const images: unknown[] = [];
		for (const part of content) {
			if (part?.type === "text" && typeof part.text === "string") {
				texts.push(part.text);
			} else if (part?.type === "image" && part.source?.type === "data") {
				images.push({ type: "image", data: part.source.value, mimeType: part.source.mimeType ?? "image/png" });
			}
		}
		return { text: texts.join("\n"), images };
	}
	return { text: "", images: [] };
}

export function createAguiServer(options: ServeOptions) {
	const supervisor = new ThreadSupervisor(options.cwd);

	const server = createServer((req, res) => {
		handle(req, res).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) json(res, 500, { error: message });
			else res.end();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";
		const method = req.method ?? "GET";

		if (method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}

		// ---------- AG-UI 标准面 ----------
		if (method === "POST" && path === "/") {
			await handleRun(req, res);
			return;
		}
		if (method === "GET" && path === "/info") {
			json(res, 200, {
				agentId: "pi",
				description: "pi 编码 agent，通过 AG-UI 协议对外服务",
				capabilities: {
					// 老实标注能力：前端据此决定怎么降级
					streaming: true,
					toolCalls: true,
					reasoning: true,
					approvals: "custom:pi.ui_request",
					stateSnapshots: false,
					reconnect: "GET /threads/:id/events?after=<seq>",
				},
			});
			return;
		}

		// ---------- 会话面 ----------
		if (method === "GET" && path === "/threads") {
			json(res, 200, { threads: listThreads() });
			return;
		}
		if (method === "POST" && path === "/threads") {
			const body = await readJson(req);
			const { cwd, threadId } = body ?? {};
			const thread = await supervisor.open(threadId, cwd);
			json(res, 200, { threadId: thread.id, sessionId: thread.sessionId, cwd: thread.cwd });
			return;
		}

		const abortMatch = /^\/threads\/([^/]+)\/abort$/.exec(path);
		if (method === "POST" && abortMatch) {
			const thread = supervisor.get(decodeURIComponent(abortMatch[1]!));
			if (!thread) {
				json(res, 404, { error: "会话不存在" });
				return;
			}
			await thread.abort();
			json(res, 200, { ok: true });
			return;
		}

		const messagesMatch = /^\/threads\/([^/]+)\/messages$/.exec(path);
		if (messagesMatch) {
			const thread = await supervisor.open(decodeURIComponent(messagesMatch[1]!));
			if (method === "GET") {
				json(res, 200, { threadId: thread.id, sessionId: thread.sessionId, messages: thread.messages() });
				return;
			}
			if (method === "POST") {
				await handleThreadMessage(req, res, thread);
				return;
			}
		}

		const eventsMatch = /^\/threads\/([^/]+)\/events$/.exec(path);
		if (method === "GET" && eventsMatch) {
			const thread = await supervisor.open(decodeURIComponent(eventsMatch[1]!));
			const after = Number(url.searchParams.get("after") ?? req.headers["last-event-id"] ?? 0) || 0;
			const sse = openSse(req, res);
			for (const record of thread.replay(after)) sse.writeSequenced(record);
			const unsubscribe = thread.subscribe((record) => sse.writeSequenced(record));
			req.on("close", unsubscribe);
			return;
		}

		const uiMatch = /^\/ui\/([^/]+)$/.exec(path);
		if (method === "POST" && uiMatch) {
			const body = await readJson(req);
			const requestId = decodeURIComponent(uiMatch[1]!);
			const thread = [...supervisorThreads()].find((candidate) => candidate.resolveUiRequest(requestId, body ?? {}));
			if (!thread) {
				json(res, 404, { error: "没有这个待回填的请求（可能已超时）" });
				return;
			}
			json(res, 200, { ok: true });
			return;
		}

		json(res, 404, { error: `没有这个接口：${method} ${path}` });
	}

	/** AG-UI 主入口：POST / 收 RunAgentInput，回一条 SSE */
	async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const input = (await readJson(req)) as RunAgentInput;
		const runId = input.runId ?? randomUUID();

		if (!input.threadId) {
			json(res, 400, { error: "RunAgentInput 缺少 threadId" });
			return;
		}

		const forwarded = (input.forwardedProps ?? {}) as { cwd?: string };
		const thread = await supervisor.open(input.threadId, forwarded.cwd);
		const { text, images } = extractUserInput(input);

		const sse = openSse(req, res);
		const unsubscribe = thread.subscribe((record) => {
			sse.write(record.event);
			const type = record.event.type;
			if (type === EventType.RUN_FINISHED || type === EventType.RUN_ERROR) {
				sse.end();
			}
		});
		req.on("close", unsubscribe);

		if (text.trim() === "" && images.length === 0) {
			sse.write({ type: EventType.RUN_STARTED, threadId: thread.id, runId } as BaseEvent);
			sse.write({ type: EventType.RUN_ERROR, message: "没有收到任何用户文本或图片" } as BaseEvent);
			sse.end();
			return;
		}

		void thread.run(runId, text, images).catch((error) => {
			sse.write({ type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : String(error) } as BaseEvent);
			sse.end();
		});
	}

	/** POST /threads/:id/messages：不走 AG-UI 的写法，直接把消息塞进去，事件走 /events */
	async function handleThreadMessage(req: IncomingMessage, res: ServerResponse, thread: Thread): Promise<void> {
		const body = await readJson(req);
		const text = typeof body?.text === "string" ? body.text : "";
		if (text.trim() === "") {
			json(res, 400, { error: "text 不能为空" });
			return;
		}
		if (thread.busy) {
			json(res, 409, { error: "该会话正在运行，先 abort 或者等它结束" });
			return;
		}
		const runId = randomUUID();
		void thread.run(runId, text, body?.images);
		json(res, 202, { runId, threadId: thread.id });
	}

	function supervisorThreads(): Thread[] {
		return supervisor.list();
	}

	function listThreads() {
		return supervisor.list().map((thread) => ({
			threadId: thread.id,
			sessionId: thread.sessionId,
			cwd: thread.cwd,
			busy: thread.busy,
			pendingUiRequests: thread.pendingUiRequests,
		}));
	}

	// 退出时收摊，避免会话 jsonl 写一半
	const shutdown = () => {
		supervisor.closeAll();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 2000).unref?.();
	};

	return {
		server,
		supervisor,
		async listen() {
			await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "127.0.0.1", resolve));
			process.on("SIGINT", shutdown);
			process.on("SIGTERM", shutdown);
			return `http://${options.host ?? "127.0.0.1"}:${options.port}`;
		},
	};
}
