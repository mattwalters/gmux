import { afterEach, describe, expect, it } from "vitest";
import { GOOGLE_CLIENT_KEY, readGoogleClient } from "../src/config.js";
import { claimOwnerIfUnclaimed } from "../src/owner.js";
import { createSession, SESSION_COOKIE } from "../src/session.js";
import { BASE_URL, callWorker, GOOGLE_CLIENT, get, OWNER, resetKv, testEnv, unconfiguredEnv } from "./helpers.js";

afterEach(resetKv);

function postClient(fields: Record<string, string>, headers: Record<string, string> = { Origin: BASE_URL }) {
	return get("/setup/google-client", { method: "POST", headers, body: new URLSearchParams(fields) });
}

const validFields = { client_id: GOOGLE_CLIENT.clientId, client_secret: GOOGLE_CLIENT.clientSecret };

async function storedClient(): Promise<string | null> {
	return testEnv.GMUX_KV.get(GOOGLE_CLIENT_KEY);
}

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

	it("offers to claim the instance once setup is complete", async () => {
		await testEnv.GMUX_KV.put(GOOGLE_CLIENT_KEY, "{}");
		const html = await (await callWorker(get("/"))).text();
		expect(html).toContain("Sign in with Google to claim this gmux");
		expect(html).toContain("Not yet claimed");
		expect(html).not.toContain("Finish setting up gmux");
	});

	it("never renders the encryption key's value", async () => {
		const html = await (await callWorker(get("/"))).text();
		expect(html).not.toContain(testEnv.TOKEN_ENCRYPTION_KEY as string);
	});
});

describe("setup wizard", () => {
	it("shows the redirect URI, a copy button, the console link and the form on a fresh deploy", async () => {
		const html = await (await callWorker(get("/"), unconfiguredEnv())).text();
		expect(html).toContain(`${BASE_URL}/signin/callback`);
		expect(html).toContain("data-copy");
		expect(html).toContain("console.cloud.google.com");
		expect(html).toContain('action="/setup/google-client"');
	});

	it("saves a valid client from the same origin, then moves on to claiming", async () => {
		const response = await callWorker(postClient(validFields));
		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe("/");
		expect(await readGoogleClient(testEnv)).toEqual(GOOGLE_CLIENT);
		expect(JSON.parse((await storedClient()) as string)).toEqual(GOOGLE_CLIENT);
		expect(await (await callWorker(get("/"))).text()).toContain("Sign in with Google to claim this gmux");
	});

	it("accepts a missing Origin only when the browser says same-origin", async () => {
		expect((await callWorker(postClient(validFields, { "Sec-Fetch-Site": "same-origin" }))).status).toBe(303);
	});

	it("accepts the Origin: null a no-referrer page's own form sends, when Sec-Fetch-Site says same-origin", async () => {
		const response = await callWorker(postClient(validFields, { Origin: "null", "Sec-Fetch-Site": "same-origin" }));
		expect(response.status).toBe(303);
	});

	it("refuses Origin: null unless Sec-Fetch-Site says same-origin", async () => {
		const attempts: Record<string, string>[] = [
			{ Origin: "null" },
			{ Origin: "null", "Sec-Fetch-Site": "cross-site" },
			{ Origin: "null", "Sec-Fetch-Site": "none" },
		];
		for (const headers of attempts) {
			expect((await callWorker(postClient(validFields, headers))).status).toBe(403);
		}
		expect(await storedClient()).toBeNull();
	});

	it("doesn't echo a secret pasted into the client ID field", async () => {
		const html = await (
			await callWorker(postClient({ client_id: "GOCSPX-pasted-secret", client_secret: "whatever" }))
		).text();
		expect(html).not.toContain("GOCSPX-pasted-secret");
	});

	it("doesn't offer the claim hand-off while the encryption key is missing", async () => {
		await testEnv.GMUX_KV.put(GOOGLE_CLIENT_KEY, JSON.stringify(GOOGLE_CLIENT));
		const html = await (await callWorker(get("/"), { ...testEnv, TOKEN_ENCRYPTION_KEY: "too-short" })).text();
		expect(html).toContain("wrangler secret put TOKEN_ENCRYPTION_KEY");
		expect(html).not.toContain("sign in with Google to claim this gmux");
	});

	it("shows an owned but unfinished instance no client form and no claim prompt", async () => {
		await testEnv.GMUX_KV.put(GOOGLE_CLIENT_KEY, JSON.stringify(GOOGLE_CLIENT));
		await claimOwnerIfUnclaimed(testEnv.GMUX_KV, OWNER);
		const html = await (await callWorker(get("/"), { ...testEnv, TOKEN_ENCRYPTION_KEY: "too-short" })).text();
		expect(html).toContain("wrangler secret put TOKEN_ENCRYPTION_KEY");
		expect(html).not.toContain('action="/setup/google-client"');
		expect(html).not.toContain("Re-enter it");
		expect(html).not.toContain("to claim this gmux");
	});

	it.each([
		["a bad client ID", { client_id: "nope", client_secret: "test-client-secret" }],
		["an empty secret", { client_id: GOOGLE_CLIENT.clientId, client_secret: "  " }],
		["a secret with a space", { client_id: GOOGLE_CLIENT.clientId, client_secret: "has space" }],
	])("rejects %s with 400 and stores nothing", async (_name, fields) => {
		const response = await callWorker(postClient(fields));
		expect(response.status).toBe(400);
		const html = await response.text();
		expect(html).not.toContain(fields.client_secret.trim() || "\0");
		expect(html).not.toContain("test-client-secret");
		expect(await storedClient()).toBeNull();
	});

	it("re-fills the client ID, never the secret, after a rejection", async () => {
		const html = await (await callWorker(postClient({ client_id: GOOGLE_CLIENT.clientId, client_secret: "" }))).text();
		expect(html).toContain(GOOGLE_CLIENT.clientId);
		expect(html).toContain("Enter the client secret.");
	});

	it("refuses a cross-site request", async () => {
		expect((await callWorker(postClient(validFields, { Origin: "https://evil.test" }))).status).toBe(403);
		expect((await callWorker(postClient(validFields, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
		expect((await callWorker(postClient(validFields, {}))).status).toBe(403);
		expect(await storedClient()).toBeNull();
	});

	it("refuses once an owner exists, and sends /setup back home", async () => {
		await claimOwnerIfUnclaimed(testEnv.GMUX_KV, OWNER);
		expect((await callWorker(postClient(validFields))).status).toBe(403);
		expect(await storedClient()).toBeNull();
		const response = await callWorker(get("/setup"));
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");
	});

	it("lets a deployer re-enter the client before anyone claims", async () => {
		await callWorker(postClient(validFields));
		const html = await (await callWorker(get("/setup"))).text();
		expect(html).toContain('action="/setup/google-client"');
		expect(html).toContain(GOOGLE_CLIENT.clientId);
		const other = { client_id: "other.apps.googleusercontent.com", client_secret: "other-secret" };
		expect((await callWorker(postClient(other))).status).toBe(303);
		expect(await readGoogleClient(testEnv)).toEqual({ clientId: other.client_id, clientSecret: other.client_secret });
	});

	it("never renders the client secret, before or after saving", async () => {
		await callWorker(postClient(validFields));
		for (const path of ["/", "/setup"]) {
			expect(await (await callWorker(get(path))).text()).not.toContain(GOOGLE_CLIENT.clientSecret);
		}
	});

	it("serves the copy script, and its CSP allows only same-origin scripts", async () => {
		const script = await callWorker(get("/copy.js"), unconfiguredEnv());
		expect(script.status).toBe(200);
		expect(script.headers.get("Content-Type")).toContain("text/javascript");
		const policy = (await callWorker(get("/setup"), unconfiguredEnv())).headers.get("Content-Security-Policy");
		expect(policy).toContain("script-src 'self'");
		expect(policy).toContain("default-src 'none'");
	});

	it("shows the signed-in owner the connection string", async () => {
		await testEnv.GMUX_KV.put(GOOGLE_CLIENT_KEY, JSON.stringify(GOOGLE_CLIENT));
		await claimOwnerIfUnclaimed(testEnv.GMUX_KV, OWNER);
		const { id } = await createSession(testEnv.GMUX_KV, OWNER);
		const response = await callWorker(get("/", { headers: { Cookie: `${SESSION_COOKIE}=${id}` } }));
		const html = await response.text();
		expect(html).toContain(`${BASE_URL}/mcp`);
		expect(html).toContain("Add custom connector");
		expect(html).not.toContain(GOOGLE_CLIENT.clientSecret);
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
