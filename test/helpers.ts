import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker, { type Env } from "../src/index.js";

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
