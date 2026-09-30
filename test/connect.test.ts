import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccount, MAIL_SCOPES, REQUIRED_SCOPES, renameAccount } from "../src/accounts.js";
import { claimOwnerIfUnclaimed } from "../src/owner.js";
import { createSession, SESSION_COOKIE } from "../src/session.js";
import { SIGN_IN_SCOPES } from "../src/signin.js";
import { readRefreshToken } from "../src/token-store.js";
import {
	BASE_URL,
	callWorker,
	fakeIdToken,
	GOOGLE_CLIENT,
	get,
	OWNER,
	resetKv,
	seedGoogleClient,
	startAdminSignIn,
	testEnv,
	validClaims,
} from "./helpers.js";

const OTHER = { sub: "2002", email: "Work@Example.com" };
const GRANTED = `openid email ${REQUIRED_SCOPES.join(" ")}`;

beforeEach(async () => {
	await seedGoogleClient();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

async function ownerSession(who = OWNER) {
	await claimOwnerIfUnclaimed(testEnv.GMUX_KV, who);
	const { id, session } = await createSession(testEnv.GMUX_KV, who);
	return { cookie: `${SESSION_COOKIE}=${id}`, csrf: session.csrf };
}

function post(path: string, fields: Record<string, string>, cookie?: string) {
	return get(path, { method: "POST", headers: cookie ? { Cookie: cookie } : {}, body: new URLSearchParams(fields) });
}

/** Presses "Connect account" (or "Reconnect") and returns Google's URL. */
async function startConnect(session: { cookie: string; csrf: string }, email?: string): Promise<URL> {
	const fields: Record<string, string> = { csrf: session.csrf };
	if (email) fields.email = email;
	const response = await callWorker(post("/accounts/connect", fields, session.cookie));
	expect(response.status).toBe(303);
	return new URL(response.headers.get("Location") as string);
}

/** Google redirects back with the given token-endpoint answer. */
async function callback(authUrl: URL, cookie: string | undefined, answer: Record<string, unknown> = {}, claims = {}) {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({
			access_token: "ya29.secret-access-token",
			refresh_token: "1//secret-refresh-token",
			scope: GRANTED,
			id_token: fakeIdToken(validClaims(authUrl.toString(), { ...OTHER, ...claims })),
			...answer,
		}),
	);
	const state = authUrl.searchParams.get("state");
	return callWorker(
		get(`/signin/callback?state=${state}&code=the-code`, cookie ? { headers: { Cookie: cookie } } : {}),
	);
}

describe("starting a connect", () => {
	it("asks for exactly the mail and Drive scopes, offline, with consent and PKCE", async () => {
		const url = await startConnect(await ownerSession());
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(
			new Set([
				"openid",
				"email",
				"https://www.googleapis.com/auth/gmail.readonly",
				"https://www.googleapis.com/auth/gmail.compose",
				"https://www.googleapis.com/auth/drive.readonly",
			]),
		);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("redirect_uri")).toBe(`${BASE_URL}/signin/callback`);
		expect(url.searchParams.get("client_id")).toBe(GOOGLE_CLIENT.clientId);
		expect(url.searchParams.get("login_hint")).toBeNull();
	});

	it("hints the account on reconnect, but only for an account on the list", async () => {
		const session = await ownerSession();
		await testEnv.GMUX_KV.put(
			"account:work@example.com",
			JSON.stringify({ email: "work@example.com", sub: "2", label: "Work", connectedAt: "x" }),
		);
		expect((await startConnect(session, "Work@example.com")).searchParams.get("login_hint")).toBe("work@example.com");
		expect((await startConnect(session, "stranger@example.com")).searchParams.get("login_hint")).toBeNull();
	});

	it("leaves the admin sign-in scopes at openid and email", async () => {
		expect([...SIGN_IN_SCOPES]).toEqual(["openid", "email"]);
		const url = new URL(await startAdminSignIn());
		expect(url.searchParams.get("scope")).toBe("openid email");
	});
});

describe("the callback", () => {
	it("stores an encrypted token and a registry record, then shows the dashboard", async () => {
		const session = await ownerSession();
		const url = await startConnect(session);
		const response = await callback(url, session.cookie);
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/?connected=work%40example.com");

		const record = await readRefreshToken(testEnv.GMUX_KV, testEnv.TOKEN_ENCRYPTION_KEY as string, "work@example.com");
		expect(record).toMatchObject({ refreshToken: "1//secret-refresh-token", email: "work@example.com" });
		expect(await testEnv.GMUX_KV.get("refresh:work@example.com")).not.toContain("1//secret-refresh-token");
		expect(await getAccount(testEnv.GMUX_KV, "work@example.com")).toMatchObject({
			label: "work@example.com",
			sub: "2002",
		});
	});

	it("uses a state once", async () => {
		const session = await ownerSession();
		const url = await startConnect(session);
		expect((await callback(url, session.cookie)).status).toBe(302);
		expect((await callback(url, session.cookie)).status).toBe(400);
	});

	it("keeps the label on a reconnect", async () => {
		const session = await ownerSession();
		await callback(await startConnect(session), session.cookie);
		await renameAccount(testEnv.GMUX_KV, "work@example.com", "Work");
		await callback(await startConnect(session, "work@example.com"), session.cookie);
		expect((await getAccount(testEnv.GMUX_KV, "work@example.com"))?.label).toBe("Work");
	});

	it("connects whichever account came back on a reconnect, and says so", async () => {
		const session = await ownerSession();
		await testEnv.GMUX_KV.put(
			"account:old@example.com",
			JSON.stringify({ email: "old@example.com", sub: "3", label: "Old", connectedAt: "x" }),
		);
		const response = await callback(await startConnect(session, "old@example.com"), session.cookie);
		expect(response.headers.get("Location")).toBe("/?connected=work%40example.com&expected=old%40example.com");
		expect(await testEnv.GMUX_KV.get("refresh:old@example.com")).toBeNull();
		expect(await getAccount(testEnv.GMUX_KV, "work@example.com")).not.toBeNull();
	});

	async function expectRefusedAndNothingStored(response: Response, status = 400) {
		expect(response.status).toBe(status);
		expect(await testEnv.GMUX_KV.get("refresh:work@example.com")).toBeNull();
		expect(await testEnv.GMUX_KV.get("account:work@example.com")).toBeNull();
		expect(await response.text()).not.toContain("secret-");
	}

	it("refuses a grant missing a mail scope, and says so", async () => {
		const session = await ownerSession();
		const response = await callback(await startConnect(session), session.cookie, {
			scope: `openid email ${MAIL_SCOPES[0]}`,
		});
		expect(response.status).toBe(400);
		expect(await response.clone().text()).toContain("leave every box ticked");
		await expectRefusedAndNothingStored(response);
	});

	it("refuses a grant that omits drive.readonly", async () => {
		const session = await ownerSession();
		const response = await callback(await startConnect(session), session.cookie, {
			scope: `openid email ${MAIL_SCOPES.join(" ")}`,
		});
		expect(response.status).toBe(400);
		expect(await response.clone().text()).toContain("leave every box ticked");
		await expectRefusedAndNothingStored(response);
	});

	it("refuses a response with no refresh token", async () => {
		const session = await ownerSession();
		const response = await callback(await startConnect(session), session.cookie, { refresh_token: undefined });
		await expectRefusedAndNothingStored(response);
	});

	it.each([
		["a bad nonce", { nonce: "wrong" }],
		["a bad audience", { aud: "someone-else" }],
	])("refuses %s", async (_name, claims) => {
		const session = await ownerSession();
		const response = await callback(await startConnect(session), session.cookie, {}, claims);
		await expectRefusedAndNothingStored(response);
	});

	it("refuses without a session, and with another session", async () => {
		const session = await ownerSession();
		const url = await startConnect(session);
		await expectRefusedAndNothingStored(await callback(url, undefined), 403);

		const { id } = await createSession(testEnv.GMUX_KV, { sub: "9999", email: "x@example.com" });
		const other = await startConnect(session);
		await expectRefusedAndNothingStored(await callback(other, `${SESSION_COOKIE}=${id}`), 403);
	});

	it("reports a cancel at Google without storing anything", async () => {
		const session = await ownerSession();
		const url = await startConnect(session);
		const response = await callWorker(
			get(`/signin/callback?state=${url.searchParams.get("state")}&error=access_denied`, {
				headers: { Cookie: session.cookie },
			}),
		);
		expect(await response.text()).toContain("Nothing was connected");
		await expectRefusedAndNothingStored(new Response("", { status: 400 }));
	});
});
