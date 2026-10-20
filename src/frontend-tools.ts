/**
 * 前端工具桥：把 AG-UI `RunAgentInput.tools` 里的工具暴露给 pi 的模型。
 *
 * 为什么要这一层：
 *   CopilotKit 的 `useFrontendTool` / `useComponent` / `useHumanInTheLoop` 注册的工具
 *   是**在前端执行**的（画图表、切主题、弹表单）。它们随 run 一起发到后端，只是为了让
 *   模型知道「有这么个工具可以调用」，后端并不真的执行它们。
 *
 * 前端工具执行只登记 handoff，不伪造浏览器的真实结果。
 * Thread 使用 Pi 的 finishTurn 在该工具批次后结束回合；AG-UI 的
 * RUN_FINISHED.outcome.pendingToolCallIds 告诉客户端执行哪些调用。
 * 下一次 run 提交 ToolMessage 后，Thread 用持久化 custom message 触发
 * 正常的 Pi 生命周期，并在 context hook 中用真实结果替换占位结果。
 * 原生扩展的 ctx.ui 确认仍使用独立的 CUSTOM 旁路。
 */

import type { Tool } from "@ag-ui/core";
import { FORWARDED_TO_CLIENT } from "./translate.ts";
import type { PiAgentTool } from "./state.ts";

export interface FrontendToolOptions {
	/** 需要跳过的工具名（比如内部状态工具），避免重名覆盖 */
	exclude?: Iterable<string>;
	/** 工具被调用时的回调，用于日志 / 埋点 */
	onForwarded?: (name: string, args: unknown, toolCallId: string) => void;
}

/** 判断一个 AG-UI 工具定义是否可用（名字和参数都得合法） */
function isUsableTool(tool: Tool): boolean {
	return typeof tool?.name === "string" && tool.name.length > 0;
}

/**
 * 把前端的工具定义转成 pi 工具。
 *
 * 注意 pi 的工具名要求比较严（会被当成模型可见的标识符），
 * 所以这里只做最小校验：名字非空即可，非法字符交给下游报错。
 */
export function toFrontendAgentTools(tools: readonly Tool[] | undefined, options: FrontendToolOptions = {}): PiAgentTool[] {
	if (!tools || tools.length === 0) return [];

	const excluded = new Set(options.exclude ?? []);
	const seen = new Set<string>();
	const result: PiAgentTool[] = [];

	for (const tool of tools) {
		if (!isUsableTool(tool)) continue;
		if (excluded.has(tool.name)) continue;
		if (seen.has(tool.name)) continue;
		seen.add(tool.name);

		// 前端工具的 parameters 已经是 JSON Schema，pi 的 TSchema 就是同一形状，直接透传；
		// 缺省时给一个「任意对象」，否则 pi 的参数校验会拒绝一切调用。
		const parameters = (
			tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {}, additionalProperties: true }
		) as never;

		const description =
			typeof tool.description === "string" && tool.description.trim() ? tool.description : `Frontend tool \`${tool.name}\`, executed in the browser.`;

		result.push({
			name: tool.name,
			label: tool.name,
			description,
			// pi 的 system prompt 只列出带 snippet 的工具，没有 snippet 等于模型看不见
			promptSnippet: `${tool.name}: ${description.split("\n")[0]!.slice(0, 120)}`,
			parameters,
			execute: async (_toolCallId: string, params: unknown) => {
				options.onForwarded?.(tool.name, params, _toolCallId);
				return {
					content: [{ type: "text" as const, text: FORWARDED_TO_CLIENT }],
					details: { forwardedToClient: true, toolName: tool.name },
					terminate: true,
				};
			},
		} as PiAgentTool);
	}

	return result;
}
