import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_CLIENT_KEY } from "../src/config.js";
import { BASE_URL, callWorker, get, testEnv, unconfiguredEnv } from "./helpers.js";

afterEach(async () => {
	await testEnv.GMUX_KV.delete(GOOGLE_CLIENT_KEY);
});

describe("boots unconfigured", () => {
	it("serves the setup page, not an error, with no secrets and no Google client", async () => {
		const response = await callWorker(get("/"), unconfiguredEnv());
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("Finish setting up gmux");
		expect(html).toContain(BASE_URL);
		expect(html).toContain("TOKEN_ENCRYPTION_KEY");
		expect(html).toContain("Not configured yet");
	});

	it("shows the encryption key as done once it's set", async () => {
		const html = await (await callWorker(get("/"))).text();
		expect(html).toContain("Set. Stored Google tokens are encrypted with it.");
		expect(html).not.toContain("wrangler secret put");
	});

	it("treats a key that isn't 32 base64 bytes as missing", async () => {
		const html = await (await callWorker(get("/"), { ...testEnv, TOKEN_ENCRYPTION_KEY: "too-short" })).text();
		expect(html).toContain("wrangler secret put TOKEN_ENCRYPTION_KEY");
	});

	it("serves the dashboard once setup is complete", async () => {
		await testEnv.GMUX_KV.put(GOOGLE_CLIENT_KEY, "{}");
		const html = await (await callWorker(get("/"))).text();
		expect(html).toContain("Setup is complete");
		expect(html).not.toContain("Finish setting up gmux");
	});

	it("never renders the encryption key's value", async () => {
		const html = await (await callWorker(get("/"))).text();
		expect(html).not.toContain(testEnv.TOKEN_ENCRYPTION_KEY as string);
	});
});

describe("admin UI", () => {
	it("serves the stylesheet as CSS", async () => {
		const response = await callWorker(get("/style.css"));
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/css");
		expect(await response.text()).toContain("--accent");
	});

	it("sets security headers on its pages", async () => {
		const response = await callWorker(get("/"));
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("returns 404 for an unknown path", async () => {
		const response = await callWorker(get("/nope"));
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("Not found");
	});
});

describe("the /mcp gate", () => {
	const mcpCall = (headers: Record<string, string> = {}) =>
		get("/mcp", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});

	it("refuses a request with no token, pointing at the resource metadata", async () => {
		const response = await callWorker(mcpCall());
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata");
	});

	it("refuses a forged bearer token", async () => {
		const response = await callWorker(mcpCall({ Authorization: "Bearer forged:forged:forged" }));
		expect(response.status).toBe(401);
	});

	it("refuses a sub-path of /mcp too", async () => {
		const response = await callWorker(get("/mcp/anything"));
		expect(response.status).toBe(401);
	});

	it("refuses with no secrets configured, rather than erroring", async () => {
		const response = await callWorker(mcpCall(), unconfiguredEnv());
		expect(response.status).toBe(401);
	});

	it("advertises this deployment's own origin as the protected resource", async () => {
		const response = await callWorker(get("/.well-known/oauth-protected-resource/mcp"));
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as { resource: string };
		expect(metadata.resource).toBe(`${BASE_URL}/mcp`);
	});

	it("follows the request's origin, so a fresh deploy needs no URL configured", async () => {
		const response = await callWorker(new Request("https://other.test/.well-known/oauth-protected-resource/mcp"));
		const metadata = (await response.json()) as { resource: string };
		expect(metadata.resource).toBe("https://other.test/mcp");
	});
});

describe("/authorize fails closed until Google sign-in exists", () => {
	it.each(["GET", "POST"])("%s never grants anything", async (method) => {
		const response = await callWorker(get("/authorize?client_id=x&response_type=code", { method }));
		expect(response.status).toBe(503);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).toContain("<title>Sign-in unavailable");
	});
});
