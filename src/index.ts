/**
 * pi-agui —— 把 pi 的 AgentSession 包成 AG-UI 服务。
 *
 * 三个层次，按需取用：
 *   createTranslator  纯函数翻译：pi 事件 → AG-UI 事件（可单测，不碰网络）
 *   Thread            一个 AG-UI thread 对应一个 pi 会话，管 run 生命周期
 *   createAguiServer  HTTP + SSE 的完整服务
 */

export {
	createTranslator,
	stringifyToolResult,
	type Translator,
	type TranslatorOptions,
} from "./translate.ts";

export {
	Thread,
	ThreadSupervisor,
	toAguiMessages,
	type EventListener,
	type OpenThreadOptions,
	type StoredEvent,
} from "./thread.ts";

export {
	createUiBridge,
	type UiBridge,
	type UiBridgeOptions,
	type UiRequest,
	type UiResponse,
} from "./ui-context.ts";

export { createAguiServer, type ServeOptions } from "./server.ts";
