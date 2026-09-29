// The protected /mcp route's tools. By the time this handler runs, the
// OAuth gate in src/gate.ts has already checked the bearer token.
//
// gmux is the hands, not the brain (AGENTS.md): tools reach Google and
// report accurately; they never summarise, digest or decide. The only tool
// so far is a health check.

import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readSetupState } from "./config.js";
import type { Env } from "./env.js";

export const SERVER_VERSION = "0.1.0";

async function healthCheck(env: Env): Promise<CallToolResult> {
	const state = await readSetupState(env);
	const lines = [
		"gmux is running.",
		`Encryption key: ${state.encryptionKey ? "set" : "missing"}.`,
		`Google OAuth client: ${state.googleClient ? "configured" : "not configured"}.`,
	];
	return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** A fresh McpServer per request, closing over `env` - the factory is handed no env of its own. */
function buildServer(env: Env): McpServer {
	const server = new McpServer({ name: "gmux", version: SERVER_VERSION });

	server.registerTool(
		"health_check",
		{
			title: "Health check",
			description: "Confirm gmux is reachable, and report which parts of its setup are complete.",
			inputSchema: z.strictObject({}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		async () => healthCheck(env),
	);

	return server;
}

export default {
	async fetch(request, env) {
		return createMcpHandler(() => buildServer(env)).fetch(request);
	},
} satisfies ExportedHandler<Env>;
