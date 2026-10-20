/**
 * 服务入口：把 pi 会话挂到 AG-UI 协议上对外提供。
 *
 *   npm run server        # 默认 127.0.0.1:3000
 *   PORT=8080 PI_AGUI_CWD=~/work npm run server
 *
 * 前端用 @ag-ui/client 的 HttpAgent 指到 http://127.0.0.1:3000 即可。
 */

import { createAguiServer } from "../src/server.ts";
import { ModelRuntime, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const cwd = process.env.PI_AGUI_CWD ?? process.cwd();

const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });

function magpieBaseUrl(): string | undefined {
	if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL.replace(/\/+$/u, "");
	const endpoint = process.env.MAGPIE_HOST?.trim();
	if (!endpoint) return undefined;
	const withProtocol = /^[a-z]+:\/\//iu.test(endpoint) ? endpoint : `http://${endpoint}`;
	return `${withProtocol.replace(/\/+$/u, "")}/v1`;
}

function modelTemplate(alias: string, fallback: Model<any>): ProviderModelConfig {
	const shortId = alias.split("/").at(-1);
	const source = modelRuntime.getModels().find((candidate) => candidate.id === shortId) ?? fallback;
	return {
		id: alias,
		name: alias,
		api: "openai-completions",
		input: source.input,
		cost: source.cost,
		reasoning: source.reasoning,
		contextWindow: source.contextWindow,
		maxTokens: source.maxTokens,
		thinkingLevelMap: source.thinkingLevelMap,
		compat: source.compat,
	};
}

async function registerMagpie(): Promise<void> {
	if (!process.env.MAGPIE_HOST && !process.env.MAGPIE_CRED) return;
	const baseUrl = magpieBaseUrl();
	const apiKey = process.env.MAGPIE_CRED ?? process.env.OPENAI_API_KEY;
	if (!baseUrl || !apiKey) throw new Error("Magpie requires both its endpoint (OPENAI_BASE_URL or MAGPIE_HOST) and credential (MAGPIE_CRED or OPENAI_API_KEY).");

	const response = await fetch(`${baseUrl}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`Magpie model discovery failed: HTTP ${response.status}`);
	const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
	const modelIds = [...new Set((payload.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0))];
	if (modelIds.length === 0) throw new Error("Magpie returned no models.");

	const fallback = modelRuntime.getModel("deepseek", "deepseek-flash") ?? modelRuntime.getModels()[0];
	if (!fallback) throw new Error("Pi model catalog is empty; cannot register Magpie models.");
	modelRuntime.registerProvider("magpie", {
		name: "Magpie",
		apiKey: process.env.MAGPIE_CRED ? "$MAGPIE_CRED" : "$OPENAI_API_KEY",
		baseUrl,
		api: "openai-completions",
		models: modelIds.map((id) => modelTemplate(id, fallback)),
	});
	await modelRuntime.refresh({ allowNetwork: false, providers: ["magpie"] });
}

await registerMagpie();
const availableModels = await modelRuntime.getAvailable();

function selectModel(models: readonly Model<any>[], requested: string | undefined, useMagpie: boolean): Model<any> {
	if (requested) {
		const references = [requested];
		if (useMagpie && !requested.startsWith("magpie/")) references.push(`magpie/${requested}`);
		const model = models.find((candidate) => references.includes(`${candidate.provider}/${candidate.id}`));
		if (!model) {
			const available = models.map((candidate) => `${candidate.provider}/${candidate.id}`).join(", ");
			throw new Error(`PI_AGUI_MODEL=${requested} is not available. Available models: ${available || "(none)"}`);
		}
		return model;
	}

	const pointModel = useMagpie ? process.env.POINT_MODEL?.trim() : undefined;
	const model = pointModel
		? models.find((candidate) => candidate.provider === "magpie" && candidate.id === pointModel)
		: useMagpie
			? models.find((candidate) => candidate.provider === "magpie")
			: models[0];
	if (!model) {
		throw new Error("No authenticated pi model is available. Configure one with `npx pi`, or set the provider API key in the environment.");
	}
	return model;
}

const useMagpie = availableModels.some((candidate) => candidate.provider === "magpie");
const model = selectModel(availableModels, process.env.PI_AGUI_MODEL?.trim() || undefined, useMagpie);
const { listen, close } = createAguiServer({
	port,
	host,
	cwd,
	sessionOptions: { modelRuntime, model },
});
const url = await listen();

console.log(`AG-UI 服务已启动：${url}`);
console.log(`工作目录：${cwd}`);
console.log(`模型：${model.provider}/${model.id}`);
console.log(`AG-UI run 入口：POST ${url}/`);

process.once("SIGINT", () => {
	void close();
});
process.once("SIGTERM", () => {
	void close();
});
