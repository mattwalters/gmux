/// <reference types="vite/client" />
// gmux never sends mail (AGENTS.md, GMX-4). The OAuth grant can send, so these
// tests are what hold the line: the guard refuses send URLs, no request the
// server builds targets one, and no source file outside src/gmail.ts talks to
// Gmail or spells a send endpoint.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_SCOPES, REQUIRED_SCOPES } from "../src/accounts.js";
import { assertNotSend, gmailFetch, looksLikeSend } from "../src/gmail.js";
import mcp from "../src/mcp.js";
import { claimOwnerIfUnclaimed } from "../src/owner.js";
import { createSession, SESSION_COOKIE } from "../src/session.js";
import {
	callWorker,
	fakeIdToken,
	get,
	OWNER,
	readMcpJson,
	resetKv,
	seedAccount,
	seedGoogleClient,
	startAdminSignIn,
	testEnv,
	validClaims,
} from "./helpers.js";

const G = "https://gmail.googleapis.com";

const SEND_URLS = [
	`${G}/gmail/v1/users/me/messages/send`,
	`${G}/gmail/v1/users/someone@example.com/messages/send`,
	`${G}/upload/gmail/v1/users/me/messages/send?uploadType=multipart`,
	`${G}/gmail/v1/users/me/drafts/send`,
	`${G}/gmail/v1/users/me/MESSAGES/SEND`,
	`${G}/gmail/v1/users/me/messages%2Fsend`,
	`${G}/gmail/v1/users/me/messages%252Fsend`,
	`${G}/gmail/v1/users/me/drafts%2fsend`,
	`${G}/gmail/v1/users/me/messages/send/`,
	`${G}//gmail/v1/users/me//messages//send`,
	`${G}/gmail/v1/users/me/messages/./send`,
	`${G}/gmail/v1/users/me/messages/x/../send`,
	`${G}/gmail/v1/users/me/messages:send`,
	`${G}/gmail/v1/users/me/drafts:send`,
	`${G}/batch`,
	`${G}/batch/gmail/v1`,
	"https://www.googleapis.com/batch/gmail/v1",
	"https://www.googleapis.com/upload/gmail/v1/users/me/messages/send",
];

const FOREIGN_URLS = ["https://evil.example.com/gmail/v1/users/me/messages", "https://oauth2.googleapis.com/token"];

const ALLOWED_PATHS = [
	"/gmail/v1/users/me/messages",
	"/gmail/v1/users/me/messages/18c3f2a",
	"/gmail/v1/users/me/drafts",
	"/gmail/v1/users/me/drafts/r-123",
	"/gmail/v1/users/me/messages?q=send",
	"/gmail/v1/users/send@example.com/messages",
];

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

describe("the send guard", () => {
	it.each(SEND_URLS)("refuses %s", async (url) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		expect(looksLikeSend(url)).toBe(true);
		expect(() => assertNotSend(url)).toThrow("gmux never sends");
		const parsed = new URL(url);
		await expect(gmailFetch("token", parsed.pathname + parsed.search)).rejects.toThrow("gmux never sends");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each(FOREIGN_URLS)("refuses the foreign host in %s", (url) => {
		expect(() => assertNotSend(url)).toThrow("gmux never sends");
	});

	it("refuses cleartext http to Gmail", () => {
		expect(() => assertNotSend("http://gmail.googleapis.com/gmail/v1/users/me/messages")).toThrow("gmux never sends");
	});

	it.each(ALLOWED_PATHS)("allows %s", async (path) => {
		expect(looksLikeSend(`${G}${path}`)).toBe(false);
		expect(() => assertNotSend(`${G}${path}`)).not.toThrow();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
		await gmailFetch("ya29.token", path);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(String(url)).toBe(`${G}${path}`);
		expect(new Headers((init as RequestInit).headers).get("Authorization")).toBe("Bearer ya29.token");
	});

	it("cannot be routed around with an absolute path argument", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(gmailFetch("token", "https://evil.example.com/x")).rejects.toThrow("gmux never sends");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("the scopes", () => {
	it("never include a scope that is broader than readonly plus compose", () => {
		expect(MAIL_SCOPES).not.toContain("https://www.googleapis.com/auth/gmail.send");
		expect(MAIL_SCOPES).not.toContain("https://www.googleapis.com/auth/gmail.modify");
		expect(MAIL_SCOPES).not.toContain("https://mail.google.com/");
	});
});

// Minimal arguments for every MCP tool. A tool missing from here fails the
// sweep, so adding a tool forces it to be swept.
const TOOL_ARGS: Record<string, Record<string, unknown>> = {
	health_check: {},
	list_accounts: {},
	drive_search: { query: "budget" },
	drive_read_file: { account: "work@example.com", file_id: "file-1" },
};

type McpReply = { result: { tools?: { name: string }[]; isError?: boolean; content?: { text?: string }[] } };

async function mcpRpc(method: string, params: unknown): Promise<McpReply> {
	const request = new Request("https://gmux.test/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const response = await mcp.fetch(request as Parameters<typeof mcp.fetch>[0], testEnv);
	return (await readMcpJson(response)) as McpReply;
}

describe("every request the server builds", () => {
	let requested: string[];

	beforeEach(async () => {
		await seedGoogleClient();
		requested = [];
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			requested.push(input instanceof Request ? input.url : String(input));
			return Response.json({
				access_token: "ya29.secret-access-token",
				refresh_token: "1//secret-refresh-token",
				scope: `openid email ${REQUIRED_SCOPES.join(" ")}`,
				id_token: fakeIdToken(validClaims("https://x.test/?nonce=none", { sub: "9", email: "a@example.com" })),
			});
		});
	});

	it("never targets a send endpoint, across every tool, connect and sign-in", async () => {
		await seedAccount("work@example.com", "1//ok-refresh");
		await seedAccount("home@example.com", "1//ok-refresh-2");

		const listed = (await mcpRpc("tools/list", {})).result.tools ?? [];
		expect(listed.length).toBeGreaterThan(0);
		for (const tool of listed) {
			expect(Object.keys(TOOL_ARGS), `tool ${tool.name} needs an entry in TOOL_ARGS`).toContain(tool.name);
			// gmailFetch refuses a send URL before fetch runs, so the request list
			// never sees it. A refusal surfaces as a tool error instead, so every
			// swept call must succeed, which also proves the tool really ran.
			const called = await mcpRpc("tools/call", { name: tool.name, arguments: TOOL_ARGS[tool.name] });
			const text = JSON.stringify(called.result?.content ?? called);
			expect(text, `tool ${tool.name} attempted a send`).not.toContain("never sends");
			expect(called.result, `tool ${tool.name} returned no result: ${text}`).toBeDefined();
			expect(called.result.isError, `tool ${tool.name} failed: ${text}`).not.toBe(true);
		}

		// Sign-in and connect, up to Google's redirect and back through the callback.
		const authUrl = await startAdminSignIn();
		await callWorker(get(`/signin/callback?state=${new URL(authUrl).searchParams.get("state")}&code=c`));
		await claimOwnerIfUnclaimed(testEnv.GMUX_KV, OWNER);
		const { id, session } = await createSession(testEnv.GMUX_KV, OWNER);
		const connect = await callWorker(
			get("/accounts/connect", {
				method: "POST",
				headers: { Cookie: `${SESSION_COOKIE}=${id}` },
				body: new URLSearchParams({ csrf: session.csrf }),
			}),
		);
		requested.push(connect.headers.get("Location") ?? "");
		const connectState = new URL(connect.headers.get("Location") as string).searchParams.get("state");
		await callWorker(
			get(`/signin/callback?state=${connectState}&code=c`, { headers: { Cookie: `${SESSION_COOKIE}=${id}` } }),
		);

		expect(requested.length).toBeGreaterThan(2);
		for (const url of requested) {
			expect(looksLikeSend(url), `request to ${url}`).toBe(false);
		}
	});
});

// Every src file as text. Vacuity is guarded below: an empty glob must not pass.
const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
	query: "?raw",
	import: "default",
	eager: true,
});

describe("the source", () => {
	const SEND_SPELLINGS = ["messages/send", "drafts/send", "messages:send", "drafts:send"];
	const GMAIL_HOSTS = ["gmail.googleapis.com", "googleapis.com/gmail", "gmail_api"];
	const GMAIL_SRC = "../src/gmail.ts";
	const others = Object.entries(sources).filter(([path]) => path !== GMAIL_SRC);

	it("found the source files", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(10);
		expect(Object.keys(sources)).toContain(GMAIL_SRC);
	});

	it("spells no send endpoint and no Gmail host outside src/gmail.ts", () => {
		for (const [path, text] of others) {
			for (const needle of [...SEND_SPELLINGS, ...GMAIL_HOSTS]) {
				expect(text.toLowerCase(), `${path} contains ${needle}`).not.toContain(needle);
			}
		}
	});

	it("keeps the send endpoints out of src/gmail.ts except inside the refusal pattern", () => {
		const gmail = sources[GMAIL_SRC] ?? "";
		for (const needle of SEND_SPELLINGS) expect(gmail.toLowerCase()).not.toContain(needle);
		expect(gmail).toContain("(messages|drafts)[/:]send");
	});
});
