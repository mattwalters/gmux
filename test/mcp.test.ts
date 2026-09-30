// Calls src/mcp.ts directly, behind the gate: test/routes.test.ts covers the
// gate itself, and test/signin.test.ts covers minting a token.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_SCOPES, REQUIRED_SCOPES } from "../src/accounts.js";
import type { Env } from "../src/env.js";
import mcp from "../src/mcp.js";
import { readMcpJson, resetKv, seedAccount, seedGoogleClient, testEnv, unconfiguredEnv } from "./helpers.js";

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

type ToolResult = { result: { isError?: boolean; content: { text: string }[] } };

async function listAccounts(env: Partial<Env> = testEnv): Promise<{ isError?: boolean; text: string }> {
	const { result } = (await rpc("tools/call", { name: "list_accounts", arguments: {} }, env)) as ToolResult;
	return { isError: result.isError, text: result.content[0].text };
}

function mockTokenEndpoint(scope: string) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		const refreshToken = new URLSearchParams(init?.body as URLSearchParams).get("refresh_token");
		return refreshToken === "1//revoked-refresh"
			? Response.json({ error: "invalid_grant" }, { status: 400 })
			: Response.json({ access_token: "ya29.secret-access-token", scope });
	});
}

const BOTH_SCOPES = REQUIRED_SCOPES.join(" ");

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

describe("MCP tools", () => {
	it("lists every tool, all read-only", async () => {
		const result = (await rpc("tools/list", {})) as { result: { tools: { name: string; annotations: unknown }[] } };
		expect(result.result.tools.map((tool) => tool.name)).toEqual([
			"health_check",
			"list_accounts",
			"drive_search",
			"drive_read_file",
		]);
		for (const tool of result.result.tools) {
			expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
		}
	});

	it("list_accounts names the unreachable account first and leaks no token", async () => {
		await seedGoogleClient();
		await seedAccount("work@example.com", "1//ok-refresh");
		await seedAccount("gone@example.com", "1//revoked-refresh");
		mockTokenEndpoint(BOTH_SCOPES);
		const { text, isError } = await listAccounts();
		const lines = text.split("\n");
		expect(isError).toBeUndefined();
		expect(lines[0]).toBe("Partial result: 1 of 2 accounts could not be reached.");
		expect(lines[1]).toContain("gone@example.com: reauth_required");
		expect(lines[1]).toContain("Reconnect it from the gmux admin page, or remove it there.");
		expect(text.indexOf("work@example.com: connected")).toBeGreaterThan(text.indexOf("gone@example.com"));
		for (const secret of ["ya29.secret-access-token", "1//ok-refresh", "1//revoked-refresh"]) {
			expect(text).not.toContain(secret);
		}
	});

	it("list_accounts reports a grant missing gmail.compose as needing reconnecting", async () => {
		await seedGoogleClient();
		await seedAccount("work@example.com", "1//ok-refresh");
		mockTokenEndpoint(MAIL_SCOPES[0]);
		const { text, isError } = await listAccounts();
		expect(isError).toBe(true);
		expect(text).toContain("reauth_required: work@example.com");
		expect(text).not.toContain(": connected");
	});

	it("list_accounts is one misconfigured error without a Google client, and never calls Google", async () => {
		await seedAccount("work@example.com", "1//ok-refresh");
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { text, isError } = await listAccounts();
		expect(isError).toBe(true);
		expect(text.split("\n")[0]).toMatch(/^misconfigured:/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("list_accounts with no accounts is an error saying so", async () => {
		await seedGoogleClient();
		const { text, isError } = await listAccounts();
		expect(isError).toBe(true);
		expect(text).toContain("No Google accounts are connected");
	});

	describe("Drive tools", () => {
		const SECRETS = ["ya29.secret-access-token", "1//ok-refresh", "1//mail-only-refresh"];

		async function call(name: string, args: Record<string, unknown>) {
			const { result } = (await rpc("tools/call", { name, arguments: args })) as ToolResult;
			return { isError: result.isError, text: result.content[0].text };
		}

		/** Token endpoint plus Drive: mail-only refresh token gets a mail-only grant. */
		function mockGoogle(driveResponse: (url: URL) => Response) {
			return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.hostname === "oauth2.googleapis.com") {
					const refreshToken = new URLSearchParams(init?.body as URLSearchParams).get("refresh_token");
					const scope = refreshToken === "1//mail-only-refresh" ? MAIL_SCOPES.join(" ") : BOTH_SCOPES;
					return Response.json({ access_token: "ya29.secret-access-token", scope });
				}
				return driveResponse(url);
			});
		}

		const file = (name: string) => ({
			id: `id-${name}`,
			name,
			mimeType: "text/plain",
			modifiedTime: "2026-02-01T00:00:00Z",
			owners: [{ emailAddress: "owner@example.com" }],
			webViewLink: `https://drive.google.com/file/d/id-${name}`,
		});

		it("names a mail-only account first and still lists the other account's files", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			await seedAccount("old@example.com", "1//mail-only-refresh", [...MAIL_SCOPES]);
			mockGoogle(() => Response.json({ files: [file("budget.txt")], nextPageToken: "more" }));
			const { text, isError } = await call("drive_search", { query: "budget" });
			const lines = text.split("\n");
			expect(isError).toBeUndefined();
			expect(lines[0]).toBe("Partial result: 1 of 2 accounts could not be reached.");
			expect(lines[1]).toContain("old@example.com: reauth_required");
			expect(text).toContain("work@example.com:");
			expect(text).toContain("budget.txt | text/plain");
			expect(text).toContain("more results exist; narrow the query");
			for (const secret of SECRETS) expect(text).not.toContain(secret);
		});

		it("says no matching files for an account that answered with none", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			mockGoogle(() => Response.json({ files: [], incompleteSearch: true }));
			const { text } = await call("drive_search", { query: "nothing" });
			expect(text).toContain("no matching files");
			expect(text).toContain("Google reports this search as incomplete");
		});

		it("escapes the query and searches one account when asked", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			await seedAccount("home@example.com", "1//ok-refresh");
			let q: string | null = null;
			mockGoogle((url) => {
				q = url.searchParams.get("q");
				return Response.json({ files: [] });
			});
			const { text } = await call("drive_search", { query: "O'Brien", account: "home@example.com" });
			expect(q).toBe("trashed = false and fullText contains 'O\\'Brien'");
			expect(text).toContain("All 1 account answered.");
		});

		it("names an unknown account", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			const { text, isError } = await call("drive_search", { account: "nobody@example.com" });
			expect(isError).toBe(true);
			expect(text).toContain("nobody@example.com");
		});

		it("reports a disabled Drive API as one misconfigured error", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			await seedAccount("home@example.com", "1//ok-refresh");
			mockGoogle(() =>
				Response.json(
					{
						error: {
							code: 403,
							errors: [{ reason: "accessNotConfigured" }],
							details: [{ reason: "SERVICE_DISABLED" }],
						},
					},
					{ status: 403 },
				),
			);
			const { text, isError } = await call("drive_search", { query: "x" });
			expect(isError).toBe(true);
			expect(text.split("\n")[0]).toBe("misconfigured: Google Drive API");
			expect(text).not.toContain("Partial result");
		});

		it("with no accounts is the existing error", async () => {
			await seedGoogleClient();
			const { text, isError } = await call("drive_search", {});
			expect(isError).toBe(true);
			expect(text).toContain("No Google accounts are connected");
		});

		it("drive_read_file renders a Doc as markdown, with metadata first", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			mockGoogle((url) =>
				url.hostname === "docs.googleapis.com"
					? Response.json({
							body: {
								content: [
									{
										paragraph: {
											paragraphStyle: { namedStyleType: "HEADING_1" },
											elements: [{ textRun: { content: "Plan\n" } }],
										},
									},
								],
							},
						})
					: Response.json({ ...file("Plan"), mimeType: "application/vnd.google-apps.document" }),
			);
			const { text, isError } = await call("drive_read_file", { account: "work@example.com", file_id: "id-Plan" });
			expect(isError).toBeUndefined();
			expect(text.indexOf("Name: Plan")).toBeLessThan(text.indexOf("# Plan"));
			expect(text).toContain("Account: work@example.com");
			for (const secret of SECRETS) expect(text).not.toContain(secret);
		});

		it("drive_read_file says when no file is visible to the account", async () => {
			await seedGoogleClient();
			await seedAccount("work@example.com", "1//ok-refresh");
			mockGoogle(() => Response.json({ error: { code: 404 } }, { status: 404 }));
			const { text, isError } = await call("drive_read_file", { account: "work@example.com", file_id: "nope" });
			expect(isError).toBe(true);
			expect(text).toBe("No file with id nope is visible to work@example.com.");
		});

		it("drive_read_file on a mail-only account is reauth_required", async () => {
			await seedGoogleClient();
			await seedAccount("old@example.com", "1//mail-only-refresh", [...MAIL_SCOPES]);
			mockGoogle(() => Response.json({}));
			const { text, isError } = await call("drive_read_file", { account: "old@example.com", file_id: "x" });
			expect(isError).toBe(true);
			expect(text).toContain("reauth_required: old@example.com");
		});
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
