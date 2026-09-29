import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_URL } from "../src/google.js";
import { OWNER_KEY, readOwner } from "../src/owner.js";
import {
	BASE_URL,
	callWorker,
	cookieOf,
	fakeIdToken,
	GOOGLE_CLIENT,
	get,
	OWNER,
	resetKv,
	seedGoogleClient,
	startAdminSignIn,
	testEnv,
	unconfiguredEnv,
	validClaims,
} from "./helpers.js";

const REDIRECT = "http://localhost:4711/callback";

beforeEach(seedGoogleClient);

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

function googleAnswers(status: number, body: unknown) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
}

/** Google's redirect back to gmux, with the given token-endpoint answer. */
async function callback(authUrl: string, claims: Record<string, unknown> = validClaims(authUrl), state?: string) {
	googleAnswers(200, { access_token: "ya29.secret-access-token", id_token: fakeIdToken(claims) });
	const stateParam = state ?? new URL(authUrl).searchParams.get("state");
	return callWorker(get(`/signin/callback?state=${stateParam}&code=the-code`));
}

/** Signs `who` in as the owner and returns the session cookie. */
async function signInAs(who: { sub: string; email: string } = OWNER): Promise<string> {
	const authUrl = await startAdminSignIn();
	const response = await callback(authUrl, validClaims(authUrl, who));
	vi.restoreAllMocks();
	return cookieOf(response);
}

describe("unconfigured", () => {
	it("serves setup or a 503, never a throw, and /mcp stays closed", async () => {
		const env = unconfiguredEnv();
		await testEnv.GMUX_KV.delete("config:google-client");
		expect((await callWorker(get("/"), env)).status).toBe(200);
		for (const path of ["/signin", "/authorize", "/signin/callback"]) {
			const response = await callWorker(get(path), env);
			expect(response.status).toBe(503);
			expect(await response.text()).toContain("Finish setup first");
		}
		expect((await callWorker(get("/mcp"), env)).status).toBe(401);
	});
});

describe("/signin", () => {
	it("redirects to Google asking for exactly openid and email", async () => {
		const response = await callWorker(get("/signin"));
		expect(response.status).toBe(302);
		const url = new URL(response.headers.get("Location") as string);
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(new Set(["openid", "email"]));
		expect(url.searchParams.get("client_id")).toBe(GOOGLE_CLIENT.clientId);
		expect(url.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/signin/callback`);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		for (const name of ["state", "code_challenge", "nonce"]) expect(url.searchParams.get(name)).toBeTruthy();
	});
});

describe("/signin/callback", () => {
	it("claims the instance for the first account and starts a session", async () => {
		const authUrl = await startAdminSignIn();
		const fetchSpy = googleAnswers(200, { id_token: fakeIdToken(validClaims(authUrl)) });
		const response = await callWorker(
			get(`/signin/callback?state=${new URL(authUrl).searchParams.get("state")}&code=c`),
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/");
		expect(await readOwner(testEnv.GMUX_KV)).toMatchObject(OWNER);

		const cookie = response.headers.get("Set-Cookie") as string;
		expect(cookie).toMatch(/^__Host-gmux_session=/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Lax");

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe(GOOGLE_TOKEN_URL);
		const form = new URLSearchParams(String(init?.body));
		expect(form.get("code_verifier")).toBeTruthy();
		expect(form.get("code")).toBe("c");
	});

	it("shows the dashboard to that session, and the sign-in page without it", async () => {
		const cookie = await signInAs();
		const signedIn = await (await callWorker(get("/", { headers: { Cookie: cookie } }))).text();
		expect(signedIn).toContain("Setup is complete");
		const anonymous = await (await callWorker(get("/"))).text();
		expect(anonymous).toContain("Sign in with Google");
		expect(anonymous).not.toContain("Setup is complete");
	});

	it("tells a second account who owns the instance, and changes nothing", async () => {
		await signInAs();
		const authUrl = await startAdminSignIn();
		const response = await callback(authUrl, validClaims(authUrl, { sub: "2002", email: "intruder@example.com" }));
		expect(response.status).toBe(403);
		expect(response.headers.get("Set-Cookie")).toBeNull();
		const html = await response.text();
		expect(html).toContain(`already claimed by <strong>${OWNER.email}</strong>`);
		expect(await readOwner(testEnv.GMUX_KV)).toMatchObject(OWNER);
	});

	it("lets the owner sign in again", async () => {
		await signInAs();
		expect(await signInAs()).toMatch(/^__Host-gmux_session=/);
	});

	it("rejects an unknown state", async () => {
		const authUrl = await startAdminSignIn();
		const response = await callback(authUrl, validClaims(authUrl), "not-a-state");
		expect(response.status).toBe(400);
		expect(await readOwner(testEnv.GMUX_KV)).toBeNull();
	});

	it("rejects a reused state", async () => {
		const authUrl = await startAdminSignIn();
		expect((await callback(authUrl)).status).toBe(302);
		expect((await callback(authUrl)).status).toBe(400);
	});

	it.each([
		["wrong audience", { aud: "someone-else" }],
		["wrong issuer", { iss: "https://evil.example" }],
		["wrong nonce", { nonce: "other" }],
		["unverified email", { email_verified: false }],
		["expired token", { exp: Math.floor(Date.now() / 1000) - 10 }],
		["missing subject", { sub: undefined }],
	])("rejects %s, with no owner and no session", async (_name, overrides) => {
		const authUrl = await startAdminSignIn();
		const response = await callback(authUrl, validClaims(authUrl, overrides));
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Sign-in failed");
		expect(response.headers.get("Set-Cookie")).toBeNull();
		expect(await testEnv.GMUX_KV.get(OWNER_KEY)).toBeNull();
	});

	it("shows a cancelled page when the user declines at Google", async () => {
		const authUrl = await startAdminSignIn();
		const state = new URL(authUrl).searchParams.get("state");
		const response = await callWorker(get(`/signin/callback?state=${state}&error=access_denied`));
		expect(await response.text()).toContain("Sign-in cancelled");
		expect(await testEnv.GMUX_KV.get(OWNER_KEY)).toBeNull();
	});

	it("maps invalid_client to a misconfigured page", async () => {
		const authUrl = await startAdminSignIn();
		googleAnswers(401, { error: "invalid_client" });
		const response = await callWorker(
			get(`/signin/callback?state=${new URL(authUrl).searchParams.get("state")}&code=c`),
		);
		expect(response.status).toBe(503);
		const html = await response.text();
		expect(html).toContain("misconfigured: Google OAuth client");
		expect(html).not.toContain(GOOGLE_CLIENT.clientSecret);
	});

	it.each([
		["a network error", () => vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"))],
		["a 503", () => googleAnswers(503, {})],
		["a 429", () => googleAnswers(429, { error: "rate_limit" })],
		["no id_token", () => googleAnswers(200, { access_token: "t" })],
	])("maps %s to an upstream-unavailable page", async (_name, arrange) => {
		const authUrl = await startAdminSignIn();
		arrange();
		const response = await callWorker(
			get(`/signin/callback?state=${new URL(authUrl).searchParams.get("state")}&code=c`),
		);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("upstream_unavailable: Google sign-in");
		expect(await testEnv.GMUX_KV.get(OWNER_KEY)).toBeNull();
	});
});

describe("the owner is on every page", () => {
	it("says so before a claim, then shows the address on setup, sign-in, 404 and the dashboard", async () => {
		expect(await (await callWorker(get("/"))).text()).toContain("Not yet claimed");
		const cookie = await signInAs();
		const pages = [
			await callWorker(get("/")),
			await callWorker(get("/", { headers: { Cookie: cookie } })),
			await callWorker(get("/nope")),
			await callWorker(get("/signin/callback?state=x")),
			await callWorker(get("/"), { ...unconfiguredEnv(), GMUX_KV: testEnv.GMUX_KV }),
		];
		for (const page of pages) expect(await page.text()).toContain(OWNER.email);
	});

	it("shows an unreadable owner record as an error, not as unclaimed", async () => {
		await testEnv.GMUX_KV.put(OWNER_KEY, "not json");
		const response = await callWorker(get("/"));
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("misconfigured: owner record");
	});
});

describe("signing out", () => {
	it("needs the session's CSRF token", async () => {
		const cookie = await signInAs();
		await callWorker(
			get("/signout", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ csrf: "wrong" }) }),
		);
		expect(await (await callWorker(get("/", { headers: { Cookie: cookie } }))).text()).toContain("Setup is complete");

		const html = await (await callWorker(get("/", { headers: { Cookie: cookie } }))).text();
		const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string;
		const response = await callWorker(
			get("/signout", { method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ csrf }) }),
		);
		expect(response.status).toBe(302);
		expect(await (await callWorker(get("/", { headers: { Cookie: cookie } }))).text()).not.toContain(
			"Setup is complete",
		);
	});
});

describe("connecting an MCP client", () => {
	const PKCE_VERIFIER = "a".repeat(64);

	async function challenge(): Promise<string> {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PKCE_VERIFIER));
		return btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replaceAll("=", "");
	}

	async function register(): Promise<string> {
		const response = await callWorker(
			get("/register", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_name: "Test Client",
					redirect_uris: [REDIRECT],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code"],
					response_types: ["code"],
				}),
			}),
		);
		expect(response.status).toBe(201);
		return ((await response.json()) as { client_id: string }).client_id;
	}

	async function authorizeUrl(clientId: string): Promise<string> {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT,
			code_challenge: await challenge(),
			code_challenge_method: "S256",
			state: "client-state",
			scope: "mcp",
		});
		return `/authorize?${params}`;
	}

	/** Registers a client, signs the owner in through /authorize, and returns the consent page's parts. */
	async function reachConsent() {
		const clientId = await register();
		const redirect = await callWorker(get(await authorizeUrl(clientId)));
		expect(redirect.status).toBe(302);
		const authUrl = redirect.headers.get("Location") as string;
		expect(authUrl).toContain("https://accounts.google.com/");
		const response = await callback(authUrl);
		vi.restoreAllMocks();
		expect(response.status).toBe(200);
		const html = await response.text();
		return {
			clientId,
			response,
			html,
			cookie: cookieOf(response),
			consent: /name="consent" value="([^"]+)"/.exec(html)?.[1] as string,
			csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1] as string,
		};
	}

	function approve(cookie: string | undefined, fields: Record<string, string>): Promise<Response> {
		return callWorker(
			get("/authorize", {
				method: "POST",
				headers: cookie ? { Cookie: cookie } : {},
				body: new URLSearchParams(fields),
			}),
		);
	}

	it("issues a token only after consent, and the token opens /mcp", async () => {
		const { clientId, response, html, cookie, consent, csrf } = await reachConsent();
		expect(html).toContain("Test Client");
		expect(html).toContain("localhost:4711");
		expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self' http://localhost:4711");

		const granted = await approve(cookie, { consent, csrf });
		expect(granted.status).toBe(302);
		const location = new URL(granted.headers.get("Location") as string);
		expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
		expect(location.searchParams.get("state")).toBe("client-state");
		const code = location.searchParams.get("code") as string;

		const tokenResponse = await callWorker(
			get("/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: REDIRECT,
					client_id: clientId,
					code_verifier: PKCE_VERIFIER,
				}),
			}),
		);
		expect(tokenResponse.status).toBe(200);
		const { access_token: bearer } = (await tokenResponse.json()) as { access_token: string };

		const tools = () =>
			callWorker(
				get("/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						Authorization: `Bearer ${bearer}`,
					},
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
				}),
			);
		expect((await tools()).status).toBe(200);

		// Changing the owner in the dashboard revokes the token and the session.
		await testEnv.GMUX_KV.put(OWNER_KEY, JSON.stringify({ sub: "9999", email: "new@example.com", claimedAt: "" }));
		expect((await tools()).status).toBe(401);
		expect(await (await callWorker(get("/", { headers: { Cookie: cookie } }))).text()).not.toContain(
			"Setup is complete",
		);
		await testEnv.GMUX_KV.delete(OWNER_KEY);
		expect((await tools()).status).toBe(401);
	});

	it("skips Google when the owner already has a session", async () => {
		const cookie = await signInAs();
		const clientId = await register();
		const response = await callWorker(get(await authorizeUrl(clientId), { headers: { Cookie: cookie } }));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Connect a client?");
	});

	it("issues nothing without a session, with a bad CSRF token or with a consent record used twice", async () => {
		const { cookie, consent, csrf } = await reachConsent();
		expect((await approve(undefined, { consent, csrf })).status).toBe(403);
		expect((await approve(cookie, { consent, csrf: "wrong" })).status).toBe(403);
		expect((await approve(cookie, { consent: "forged", csrf })).status).toBe(403);
		expect((await approve(cookie, { consent, csrf })).status).toBe(302);
		expect((await approve(cookie, { consent, csrf })).status).toBe(403);
	});

	it("refuses a session that isn't the owner's", async () => {
		const { cookie, consent, csrf } = await reachConsent();
		await testEnv.GMUX_KV.put(OWNER_KEY, JSON.stringify({ sub: "9999", email: "new@example.com", claimedAt: "" }));
		expect((await approve(cookie, { consent, csrf })).status).toBe(403);
	});

	it("refuses an unknown client or an unregistered redirect URI", async () => {
		const unknown = await callWorker(get(await authorizeUrl("nobody")));
		expect(unknown.status).toBe(400);
		const clientId = await register();
		const badRedirect = (await authorizeUrl(clientId)).replace(
			encodeURIComponent(REDIRECT),
			"https%3A%2F%2Fevil.example%2Fcb",
		);
		expect((await callWorker(get(badRedirect))).status).toBe(400);
	});
});

describe("nothing secret is ever served", () => {
	it("keeps the client secret, Google's tokens and the encryption key out of every response", async () => {
		const authUrl = await startAdminSignIn();
		googleAnswers(200, { access_token: "ya29.secret-access-token", id_token: fakeIdToken(validClaims(authUrl)) });
		const responses = [
			await callWorker(get("/signin")),
			await callWorker(get(`/signin/callback?state=${new URL(authUrl).searchParams.get("state")}&code=c`)),
			await callWorker(get("/")),
		];
		const idToken = fakeIdToken(validClaims(authUrl));
		for (const response of responses) {
			const text = `${await response.text()}${[...response.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}`;
			for (const secret of [
				GOOGLE_CLIENT.clientSecret,
				"ya29.secret-access-token",
				idToken,
				testEnv.TOKEN_ENCRYPTION_KEY as string,
			]) {
				expect(text).not.toContain(secret);
			}
		}
	});
});
