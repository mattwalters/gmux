import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_SCOPES, renameAccount, saveAccount } from "../src/accounts.js";
import { GOOGLE_TOKEN_URL } from "../src/google.js";
import { claimOwnerIfUnclaimed } from "../src/owner.js";
import { createSession, SESSION_COOKIE } from "../src/session.js";
import { writeRefreshToken } from "../src/token-store.js";
import { callWorker, get, OWNER, resetKv, seedGoogleClient, testEnv } from "./helpers.js";

const KV = testEnv.GMUX_KV;
const WHEN = "2026-01-01T00:00:00.000Z";

beforeEach(async () => {
	await seedGoogleClient();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

async function ownerSession() {
	await claimOwnerIfUnclaimed(KV, OWNER);
	const { id, session } = await createSession(KV, OWNER);
	return { cookie: `${SESSION_COOKIE}=${id}`, csrf: session.csrf };
}

async function seedAccount(email: string, refreshToken: string) {
	await writeRefreshToken(KV, testEnv.TOKEN_ENCRYPTION_KEY as string, email, {
		refreshToken,
		email,
		scopes: [...REQUIRED_SCOPES],
		connectedAt: WHEN,
	});
	await saveAccount(KV, { email, sub: email, connectedAt: WHEN });
}

/** The token endpoint: a healthy refresh for `ok-refresh`, invalid_grant for anything else. */
function mockGoogle(answer?: (refreshToken: string) => Response) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		expect(String(input)).toBe(GOOGLE_TOKEN_URL);
		const refreshToken = new URLSearchParams(init?.body as URLSearchParams).get("refresh_token") as string;
		if (answer) return answer(refreshToken);
		return refreshToken === "1//ok-refresh"
			? Response.json({ access_token: "ya29.secret-access-token" })
			: Response.json({ error: "invalid_grant" }, { status: 400 });
	});
}

describe("the dashboard", () => {
	it("lists every account with its state, and a revoked one reads Reconnect with the sentence", async () => {
		await seedAccount("good@example.com", "1//ok-refresh");
		await seedAccount("revoked@example.com", "1//revoked-refresh");
		await renameAccount(KV, "good@example.com", "Personal");
		mockGoogle();

		const response = await callWorker(get("/", { headers: { Cookie: (await ownerSession()).cookie } }));
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Personal");
		expect(html).toContain("good@example.com");
		expect(html).toContain("revoked@example.com");
		expect(html).toContain("Connected");
		expect(html).toContain("Needs reconnecting");
		expect(html).toContain(
			"The revoked@example.com account needs reconnecting. Reconnect it from the gmux admin page, or remove it there.",
		);
		expect(html.match(/>\s*Reconnect\s*</g)).toHaveLength(1);
		expect(html.match(/>\s*Remove\s*</g)).toHaveLength(2);
		expect(html).toContain("gmux never sends");
		expect(html).toContain(OWNER.email);
		for (const secret of ["ok-refresh", "revoked-refresh", "ya29.secret-access-token"]) {
			expect(html).not.toContain(secret);
		}
	});

	it("shows a misconfigured client once, as a banner", async () => {
		await seedAccount("a@example.com", "1//a");
		await seedAccount("b@example.com", "1//b");
		mockGoogle(() => Response.json({ error: "invalid_client" }, { status: 401 }));
		const html = await (await callWorker(get("/", { headers: { Cookie: (await ownerSession()).cookie } }))).text();
		expect(html.match(/fully set up/g)).toHaveLength(1);
	});

	it("says so when no accounts are connected, without calling Google", async () => {
		const fetchSpy = mockGoogle();
		const html = await (await callWorker(get("/", { headers: { Cookie: (await ownerSession()).cookie } }))).text();
		expect(html).toContain("No Google accounts are connected yet");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("account POSTs", () => {
	const paths = ["/accounts/connect", "/accounts/rename", "/accounts/remove"];

	function post(path: string, fields: Record<string, string>, cookie?: string) {
		return get(path, { method: "POST", headers: cookie ? { Cookie: cookie } : {}, body: new URLSearchParams(fields) });
	}

	it.each(paths)("%s refuses without a session", async (path) => {
		await seedAccount("a@example.com", "1//a");
		await ownerSession();
		expect((await callWorker(post(path, { csrf: "x", email: "a@example.com" }))).status).toBe(403);
		expect(await KV.get("account:a@example.com")).not.toBeNull();
	});

	it.each(paths)("%s refuses a bad CSRF token", async (path) => {
		await seedAccount("a@example.com", "1//a");
		const { cookie } = await ownerSession();
		expect((await callWorker(post(path, { csrf: "wrong", email: "a@example.com" }, cookie))).status).toBe(403);
		expect((await callWorker(post(path, { email: "a@example.com" }, cookie))).status).toBe(403);
		expect(await KV.get("account:a@example.com")).not.toBeNull();
	});

	it("renames and removes with a valid session", async () => {
		await seedAccount("a@example.com", "1//a");
		const { cookie, csrf } = await ownerSession();
		const renamed = await callWorker(post("/accounts/rename", { csrf, email: "a@example.com", label: "Work" }, cookie));
		expect(renamed.status).toBe(303);
		expect(JSON.parse((await KV.get("account:a@example.com")) as string).label).toBe("Work");
		expect(
			(await callWorker(post("/accounts/rename", { csrf, email: "a@example.com", label: "x".repeat(65) }, cookie)))
				.status,
		).toBe(400);

		const removed = await callWorker(post("/accounts/remove", { csrf, email: "a@example.com" }, cookie));
		expect(removed.status).toBe(303);
		expect(await KV.get("account:a@example.com")).toBeNull();
		expect(await KV.get("refresh:a@example.com")).toBeNull();
	});
});
