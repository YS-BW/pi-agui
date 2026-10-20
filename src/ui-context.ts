/**
 * 把 pi 扩展的 UI 交互（确认 / 选择 / 输入 / 通知 / 状态栏）桥到前端。
 *
 * pi 的 `ExtensionUIContext` 是给 TUI 设计的：`confirm()` 返回 Promise<boolean>，
 * 而 TUI 里是靠键盘回填这个 Promise。服务化之后没人按键，所以这里：
 *
 *   扩展调 confirm()  →  发一条 CUSTOM 事件给前端  →  挂起 Promise
 *   前端 POST 回填     →  resolve Promise          →  扩展继续跑
 *
 * 关键：**不关 SSE 流**。AG-UI 标准的 interrupt 方案要求 run 结束再开新 run 恢复，
 * 而 pi 的工具执行是卡在 await 里的，杀 run 就丢了上下文。所以走 CUSTOM 旁路，
 * 这是务实解，不是规范解。
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** 一次待回填的 UI 请求 */
export interface UiRequest {
	id: string;
	/** confirm / select / input / editor */
	method: "confirm" | "select" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
}

/** 前端回填的载荷 */
export interface UiResponse {
	/** select / input / editor 的值 */
	value?: string;
	/** confirm 的结果 */
	confirmed?: boolean;
	/** 用户取消 */
	cancelled?: boolean;
}

interface Pending {
	settle(response: UiResponse): void;
}

export interface UiBridge {
	/** 交给 session.bindExtensions() 的 uiContext */
	context: ExtensionUIContext;
	/** 前端回填答案 */
	resolve(requestId: string, response: UiResponse): boolean;
	/** run 结束/中断时清掉所有挂起请求（扩展会拿到默认值继续跑） */
	cancelAll(): void;
	/** 当前挂起的请求数 */
	readonly pendingCount: number;
}

/** 主题桩：前端不渲染主题，扩展里的 theme.fg() 之类直接原样返回文本 */
function createThemeStub(): Theme {
	return new Proxy({} as Record<string, unknown>, {
		get(_target, property) {
			if (property === "name") return "agui";
			return (colorOrText: unknown, text?: unknown) => (typeof text === "string" ? text : String(colorOrText ?? ""));
		},
	}) as unknown as Theme;
}

export interface UiBridgeOptions {
	/** 发起一个需要人工回填的请求 */
	onRequest(request: UiRequest): void;
	/** 一次性通知（fire and forget） */
	onNotify(message: string, type: "info" | "warning" | "error"): void;
	/** 状态栏文本变化 */
	onStatus(key: string, text: string | undefined): void;
	/** 扩展想往前端塞一块自定义展示内容 */
	onWidget(key: string, lines: string[] | undefined, placement?: string): void;
}

export function createUiBridge(options: UiBridgeOptions): UiBridge {
	const pending = new Map<string, Pending>();
	const themeStub = createThemeStub();
	let counter = 0;

	function dialog<T>(
		method: UiRequest["method"],
		build: () => Omit<UiRequest, "id" | "method">,
		opts: { signal?: AbortSignal; timeout?: number } | undefined,
		defaultValue: T,
		parse: (response: UiResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = `${method}_${++counter}_${Math.random().toString(36).slice(2, 8)}`;
		const request: UiRequest = { id, method, ...build() };

		return new Promise<T>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;

			const settle = (response: UiResponse) => {
				if (!pending.has(id)) return;
				pending.delete(id);
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				resolve(response.cancelled ? defaultValue : parse(response));
			};

			const onAbort = () => settle({ cancelled: true });

			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) {
				timer = setTimeout(() => settle({ cancelled: true }), opts.timeout);
			}

			// 先登记再发事件，避免前端回填比登记还快
			pending.set(id, { settle });
			options.onRequest(request);
		});
	}

	// 只声明服务化真正用得上的那几个方法，其余 TUI 专属能力按默认值吞掉
	type ServedUiMethods = Pick<ExtensionUIContext, "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget">;

	const context: ServedUiMethods & Record<string, unknown> = {
		select(title, choices, opts) {
			return dialog<string | undefined>(
				"select",
				() => ({ title, options: choices }),
				opts,
				undefined,
				(r) => r.value ?? undefined,
			);
		},
		confirm(title, message, opts) {
			return dialog<boolean>(
				"confirm",
				() => ({ title, message }),
				opts,
				false,
				(r) => r.confirmed === true,
			);
		},
		input(title, placeholder, opts) {
			return dialog<string | undefined>(
				"input",
				() => ({ title, placeholder }),
				opts,
				undefined,
				(r) => r.value ?? undefined,
			);
		},
		editor(title, prefill) {
			return dialog<string | undefined>(
				"editor",
				() => ({ title, prefill }),
				undefined,
				undefined,
				(r) => r.value ?? undefined,
			);
		},

		notify(message, type) {
			options.onNotify(message, type ?? "info");
		},
		setStatus(key, text) {
			options.onStatus(key, text);
		},
		setWidget(key, content) {
			// 只支持字符串数组形态，组件工厂在无 TUI 环境里无法渲染
			if (content === undefined || Array.isArray(content)) {
				options.onWidget(key, content as string[] | undefined);
			}
		},

		// ---- 以下都是 TUI 专属能力，服务化场景下按默认值吞掉 ----
		onTerminalInput() {
			return () => {};
		},
		setWorkingMessage() {},
		setWorkingVisible() {},
		setWorkingIndicator() {},
		setHiddenThinkingLabel() {},
		setFooter() {},
		setHeader() {},
		setTitle() {},
		async custom() {
			return undefined;
		},
		pasteToEditor() {},
		setEditorText() {},
		getEditorText() {
			return "";
		},
		addAutocompleteProvider() {},
		setEditorComponent() {},
		getEditorComponent() {
			return undefined;
		},
		get theme() {
			return themeStub;
		},
		getAllThemes() {
			return [];
		},
		getTheme() {
			return undefined;
		},
		setTheme() {
			return { success: false, error: "服务化模式下不支持切换主题" };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded() {},
	};

	return {
		context: context as unknown as ExtensionUIContext,
		resolve(requestId, response) {
			const request = pending.get(requestId);
			if (!request) return false;
			request.settle(response);
			return true;
		},
		cancelAll() {
			for (const [, entry] of [...pending]) entry.settle({ cancelled: true });
			pending.clear();
		},
		get pendingCount() {
			return pending.size;
		},
	};
}
