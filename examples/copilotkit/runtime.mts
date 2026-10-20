import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, InMemoryAgentRunner, createCopilotEndpoint } from "@copilotkit/runtime/v2";

/** Matches CopilotKit's official claude-sdk-typescript example. */
export function createPiEndpoint(url = process.env.PI_AGUI_URL ?? "http://127.0.0.1:3000") {
	const runtime = new CopilotRuntime({
		agents: { default: new HttpAgent({ url }) },
		runner: new InMemoryAgentRunner(),
	});
	return createCopilotEndpoint({ runtime, basePath: "/api/copilotkit" });
}
