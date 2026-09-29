// Calls src/mcp.ts directly, behind the gate: test/routes.test.ts covers the
// gate itself, and test/signin.test.ts covers minting a token.

import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import mcp from "../src/mcp.js";
import { readMcpJson, testEnv, unconfiguredEnv } from "./helpers.js";

async function rpc(method: string, params: unknown, env: Partial<Env> = testEnv): Promise<unknown> {
	const request = new Request("https://gmux.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const response = await mcp.fetch(request as Parameters<typeof mcp.fetch>[0], env as Env);
	expect(response.status).toBe(200);
	return readMcpJson(response);
}

describe("MCP tools", () => {
	it("lists the health check as the only tool, read-only", async () => {
		const result = (await rpc("tools/list", {})) as { result: { tools: { name: string; annotations: unknown }[] } };
		expect(result.result.tools.map((tool) => tool.name)).toEqual(["health_check"]);
		expect(result.result.tools[0].annotations).toMatchObject({ readOnlyHint: true });
	});

	it("health_check reports what's configured", async () => {
		const result = (await rpc("tools/call", { name: "health_check", arguments: {} }, unconfiguredEnv())) as {
			result: { content: { text: string }[] };
		};
		const text = result.result.content[0].text;
		expect(text).toContain("gmux is running.");
		expect(text).toContain("Encryption key: missing.");
		expect(text).toContain("Google OAuth client: not configured.");
	});
});
