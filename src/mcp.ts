// The protected /mcp route's tools. By the time this handler runs, the
// OAuth gate in src/gate.ts has already checked the bearer token.
//
// gmux is the hands, not the brain (AGENTS.md): tools reach Google and
// report accurately; they never summarise, digest or decide. The tools so
// far are a health check and list_accounts. Mail requests go through
// gmailFetch (src/gmail.ts), which refuses the send endpoints (GMX-4).

import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkAccount, listAccounts } from "./accounts.js";
import { readEncryptionKey, readGoogleClient, readSetupState } from "./config.js";
import type { Env } from "./env.js";
import { toolError } from "./errors.js";
import { fanOut, renderFanOut } from "./fanout.js";

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

/** Every connected account, each probed with a live token refresh through the fan-out. */
async function listAccountsTool(env: Env): Promise<CallToolResult> {
	try {
		readEncryptionKey(env);
		const client = await readGoogleClient(env);
		const accounts = await listAccounts(env.GMUX_KV);
		const outcome = await fanOut(accounts, (account) => checkAccount(env, client, account.email));
		return renderFanOut(outcome, () => "connected");
	} catch (error) {
		return toolError(error);
	}
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

	server.registerTool(
		"list_accounts",
		{
			title: "List accounts",
			description: "List every connected Google account with its label, email and whether gmux can reach it right now.",
			inputSchema: z.strictObject({}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		},
		async () => listAccountsTool(env),
	);

	return server;
}

export default {
	async fetch(request, env) {
		return createMcpHandler(() => buildServer(env)).fetch(request);
	},
} satisfies ExportedHandler<Env>;
