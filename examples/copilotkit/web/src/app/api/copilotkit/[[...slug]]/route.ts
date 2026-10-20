import { HttpAgent } from "@ag-ui/client";
import {
	CopilotRuntime,
	createCopilotRuntimeHandler,
	InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE_PATH = "/api/copilotkit";

type LocalThread = {
	id: string;
	name: string | null;
	[field: string]: unknown;
};

type LocalThreadList = {
	threads: LocalThread[];
	nextCursor?: string | null;
};

type LocalThreadState = {
	names: Map<string, string>;
	deleted: Set<string>;
};

type LocalThreadGlobal = typeof globalThis & {
	__PI_AGUI_LOCAL_THREAD_STATE__?: LocalThreadState;
};

const localThreadGlobal = globalThis as LocalThreadGlobal;
localThreadGlobal.__PI_AGUI_LOCAL_THREAD_STATE__ ??= {
	names: new Map<string, string>(),
	deleted: new Set<string>(),
};
const localThreadState = localThreadGlobal.__PI_AGUI_LOCAL_THREAD_STATE__;

const runtimeHandler = createCopilotRuntimeHandler({
	runtime: new CopilotRuntime({
		agents: {
			default: new HttpAgent({
				url: process.env.PI_AGUI_URL ?? "http://127.0.0.1:4000",
			}),
		},
		runner: new InMemoryAgentRunner(),
	}),
	basePath: "/api/copilotkit",
});

function relativePath(request: Request): string {
	const pathname = new URL(request.url).pathname;
	if (!pathname.startsWith(BASE_PATH)) return pathname;
	return pathname.slice(BASE_PATH.length) || "/";
}

async function decorateResponse(
	response: Response,
	transform: (payload: Record<string, unknown>) => Record<string, unknown>,
): Promise<Response> {
	const payload = (await response.json()) as Record<string, unknown>;
	const headers = new Headers(response.headers);
	headers.delete("content-length");
	return Response.json(transform(payload), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function handler(request: Request): Promise<Response> {
	const path = relativePath(request);

	// The OSS InMemoryAgentRunner exposes readable thread endpoints but the
	// runtime intentionally advertises metadata mutations as Intelligence-only.
	// This example layers process-local names and sidebar deletion over that
	// read-only fallback so the standalone demo behaves like the hosted drawer.
	if (request.method === "GET" && path === "/info") {
		const response = await runtimeHandler(request);
		if (!response.ok) return response;
		return decorateResponse(response, (payload) => {
			const threadEndpoints =
				payload.threadEndpoints &&
				typeof payload.threadEndpoints === "object"
					? payload.threadEndpoints
					: {};
			return {
				...payload,
				threadEndpoints: {
					...threadEndpoints,
					mutations: true,
				},
			};
		});
	}

	if (request.method === "GET" && path === "/threads") {
		const response = await runtimeHandler(request);
		if (!response.ok) return response;
		return decorateResponse(response, (payload) => {
			const threadList = payload as LocalThreadList;
			return {
				...payload,
				threads: threadList.threads
					.filter((thread) => !localThreadState.deleted.has(thread.id))
					.map((thread) => ({
						...thread,
						name:
							localThreadState.names.get(thread.id) ?? thread.name ?? null,
					})),
			};
		});
	}

	const threadMatch = path.match(/^\/threads\/([^/]+)$/u);
	if (threadMatch && (request.method === "PATCH" || request.method === "DELETE")) {
		const threadId = decodeURIComponent(threadMatch[1]);

		if (request.method === "PATCH") {
			const body = (await request.json()) as {
				name?: unknown;
				archived?: unknown;
			};
			if (typeof body.name === "string" && body.name.trim()) {
				localThreadState.names.set(threadId, body.name.trim());
			}
			if (body.archived === false) {
				localThreadState.deleted.delete(threadId);
			}
			return Response.json({
				id: threadId,
				name: localThreadState.names.get(threadId) ?? null,
			});
		}

		localThreadState.names.delete(threadId);
		localThreadState.deleted.add(threadId);
		return Response.json({ threadId, deleted: true });
	}

	return runtimeHandler(request);
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
