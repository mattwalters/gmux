import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { REQUIRED_SCOPES, saveAccount } from "../src/accounts.js";
import worker, { type Env } from "../src/index.js";
import { writeRefreshToken } from "../src/token-store.js";

export const BASE_URL = "https://gmux.test";

// `cloudflare:test`'s `env` is typed as the default Cloudflare.Env; Env is
// hand-written in src/env.ts. Cast once here.
export const testEnv = env as unknown as Env;

/** Drives a request through the whole Worker, gate included, with the exact env given. */
export async function callWorker(request: Request, workerEnv: Partial<Env> = testEnv): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request as Parameters<typeof worker.fetch>[0], workerEnv as Env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

export function get(path: string, init?: RequestInit): Request {
	return new Request(`${BASE_URL}${path}`, init);
}

/** An env with every binding but no secrets at all: what a fresh deploy looks like. */
export function unconfiguredEnv(): Partial<Env> {
	const { TOKEN_ENCRYPTION_KEY: _, ...rest } = testEnv;
	return rest;
}

/** MCP responses come back as plain JSON or as a single-event SSE stream. */
export async function readMcpJson(response: Response): Promise<unknown> {
	const contentType = response.headers.get("Content-Type") ?? "";
	if (contentType.includes("application/json")) return response.json();
	const text = await response.text();
	const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
	if (!dataLine) throw new Error(`no "data:" line in SSE body: ${text}`);
	return JSON.parse(dataLine.slice("data:".length).trim());
}

export const GOOGLE_CLIENT = {
	clientId: "test-client-id.apps.googleusercontent.com",
	clientSecret: "test-client-secret",
};
export const OWNER = { sub: "1001", email: "owner@example.com" };

/** Deletes every key in both KV namespaces, so tests don't see each other's owner, sessions or clients. */
export async function resetKv(): Promise<void> {
	for (const kv of [testEnv.GMUX_KV, testEnv.OAUTH_KV]) {
		const { keys } = await kv.list();
		await Promise.all(keys.map((key) => kv.delete(key.name)));
	}
}

export async function seedGoogleClient(): Promise<void> {
	await testEnv.GMUX_KV.put("config:google-client", JSON.stringify(GOOGLE_CLIENT));
}

/** A connected account: a stored refresh token plus its registry record. */
export async function seedAccount(email: string, refreshToken: string, scopes: string[] = [...REQUIRED_SCOPES]) {
	const connectedAt = "2026-01-01T00:00:00.000Z";
	await writeRefreshToken(testEnv.GMUX_KV, testEnv.TOKEN_ENCRYPTION_KEY as string, email, {
		refreshToken,
		email,
		scopes,
		connectedAt,
	});
	await saveAccount(testEnv.GMUX_KV, { email, sub: email, connectedAt });
}

function base64url(text: string): string {
	return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** An unsigned id_token: gmux reads its payload only, having fetched it from Google itself. */
export function fakeIdToken(claims: Record<string, unknown>): string {
	return `${base64url(JSON.stringify({ alg: "none" }))}.${base64url(JSON.stringify(claims))}.sig`;
}

/** Claims that pass every check for the sign-in gmux sent to `authUrl`, with `overrides` on top. */
export function validClaims(authUrl: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iss: "https://accounts.google.com",
		aud: GOOGLE_CLIENT.clientId,
		exp: Math.floor(Date.now() / 1000) + 3600,
		nonce: new URL(authUrl).searchParams.get("nonce"),
		email_verified: true,
		...OWNER,
		...overrides,
	};
}

/** Sends the browser to /signin and returns the Google URL it's redirected to. */
export async function startAdminSignIn(): Promise<string> {
	const response = await callWorker(get("/signin"));
	return response.headers.get("Location") as string;
}

/** The name=value part of a Set-Cookie header. */
export function cookieOf(response: Response): string {
	return (response.headers.get("Set-Cookie") ?? "").split(";")[0];
}
