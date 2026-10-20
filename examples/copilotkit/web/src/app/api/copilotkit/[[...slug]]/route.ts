import { HttpAgent } from "@ag-ui/client";
import {
	CopilotRuntime,
	createCopilotRuntimeHandler,
	InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createCopilotRuntimeHandler({
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

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
