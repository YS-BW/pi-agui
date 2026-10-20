import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext, type JsonObject } from "@earendil-works/pi-ai";
import { createAguiServer } from "../src/server.ts";

export type Reply = {
	text?: string;
	calls?: { id: string; name: string; arguments: JsonObject }[];
	error?: string;
	wait?: Promise<void>;
};
export async function fixture(respond: (context: TranscriptContext, index: number) => Reply, extensions: ExtensionFactory[] = []) {
	const dir = await mkdtemp(join(tmpdir(), "pi-agui-test-"));
	const requests: TranscriptContext[] = [];
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	runtime.registerProvider("agui-fixture", {
		api: "openai-completions",
		apiKey: "fixture-only",
		baseUrl: "http://127.0.0.1:1",
		models: [
			{
				id: "fixture",
				name: "fixture",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 4096,
			},
		],
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			requests.push(structuredClone(context));
			const reply = respond(context, requests.length - 1);
			void (async () => {
				if (reply.wait)
					await Promise.race([
						reply.wait,
						new Promise<void>((resolve) => {
							if (options?.signal?.aborted) resolve();
							else
								options?.signal?.addEventListener("abort", () => resolve(), {
									once: true,
								});
						}),
					]);
				const aborted = options?.signal?.aborted;
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					stopReason: aborted ? "aborted" : reply.error ? "error" : reply.calls?.length ? "toolUse" : "stop",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					...(reply.error ? { errorMessage: reply.error } : {}),
				};
				stream.push({ type: "start", partial: message });
				if (reply.text) {
					message.content.push({ type: "text", text: reply.text });
					stream.push({
						type: "text_start",
						contentIndex: 0,
						partial: message,
					});
					stream.push({
						type: "text_delta",
						contentIndex: 0,
						delta: reply.text,
						partial: message,
					});
					stream.push({
						type: "text_end",
						contentIndex: 0,
						content: reply.text,
						partial: message,
					});
				}
				for (const call of reply.calls ?? []) {
					const contentIndex = message.content.length;
					const toolCall = { type: "toolCall" as const, ...call };
					message.content.push(toolCall);
					stream.push({
						type: "toolcall_start",
						contentIndex,
						partial: message,
					});
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta: JSON.stringify(call.arguments),
						partial: message,
					});
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall,
						partial: message,
					});
				}
				if (aborted || reply.error)
					stream.push({
						type: "error",
						reason: aborted ? "aborted" : "error",
						error: message,
					});
				else
					stream.push({
						type: "done",
						reason: message.stopReason as "stop" | "toolUse",
						message,
					});
				stream.end(message);
			})();
			return stream;
		},
	});
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const app = createAguiServer({
		port: 0,
		cwd: dir,
		agentDir: dir,
		sessionOptions: {
			modelRuntime: runtime,
			model: runtime.getModel("agui-fixture", "fixture"),
			settingsManager: settings,
			noTools: "builtin",
			thinkingLevel: "off",
		},
		loaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			settingsManager: settings,
			extensionFactories: extensions,
		},
	});
	const url = await app.listen();
	return {
		...app,
		url,
		requests,
		dir,
		async cleanup() {
			await app.close();
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export function input(threadId = "t1", runId = "r1", text = "hello") {
	return {
		threadId,
		runId,
		messages: [{ id: runId + "_user", role: "user" as const, content: text }],
		tools: [],
		context: [],
		state: {},
		forwardedProps: {},
	};
}
export async function post(url: string, body: unknown, path = "/") {
	return fetch(url + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	});
}
export async function events(response: Response): Promise<any[]> {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)));
}
