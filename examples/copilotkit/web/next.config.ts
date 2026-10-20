import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
	agentRules: false,
	devIndicators: false,
	turbopack: {
		root: fileURLToPath(new URL(".", import.meta.url)),
	},
	output: "standalone",
	serverExternalPackages: ["@copilotkit/runtime"],
};

export default nextConfig;
