import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_TOKEN_URL, getAccessToken } from "../src/google.js";
import { readRefreshToken, writeRefreshToken } from "../src/token-store.js";
import { testEnv } from "./helpers.js";

const CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };
const KEY = testEnv.TOKEN_ENCRYPTION_KEY as string;
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

async function connect(account: string): Promise<void> {
	await writeRefreshToken(testEnv.GMUX_KV, KEY, account, {
		refreshToken: "1//stored",
		email: `${account}@example.com`,
		scopes: SCOPES,
		connectedAt: "2026-01-01T00:00:00.000Z",
	});
}

function googleAnswers(status: number, body: unknown) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getAccessToken", () => {
	it("returns the access token and posts the stored refresh token to Google", async () => {
		await connect("work");
		const fetchSpy = googleAnswers(200, { access_token: "ya29.fresh" });
		expect(await getAccessToken(testEnv, CLIENT, "work")).toEqual({ accessToken: "ya29.fresh", scopes: SCOPES });

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe(GOOGLE_TOKEN_URL);
		const form = new URLSearchParams(String(init?.body));
		expect(form.get("refresh_token")).toBe("1//stored");
		expect(form.get("client_id")).toBe(CLIENT.clientId);
	});

	it("reports the refreshed scopes when Google sends them", async () => {
		await connect("work");
		googleAnswers(200, { access_token: "t", scope: "a b" });
		expect((await getAccessToken(testEnv, CLIENT, "work")).scopes).toEqual(["a", "b"]);
	});

	it("stores a rotated refresh token, encrypted", async () => {
		await connect("work");
		googleAnswers(200, { access_token: "t", refresh_token: "1//rotated" });
		await getAccessToken(testEnv, CLIENT, "work");
		expect((await readRefreshToken(testEnv.GMUX_KV, KEY, "work")).refreshToken).toBe("1//rotated");
	});

	it("throws reauth_required for an account that was never connected, without calling Google", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(getAccessToken(testEnv, CLIENT, "nobody")).rejects.toMatchObject({ reason: "not_connected" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each(["invalid_grant", "invalid_scope"])("maps %s to reauth_required (revoked)", async (error) => {
		await connect("work");
		googleAnswers(400, { error });
		await expect(getAccessToken(testEnv, CLIENT, "work")).rejects.toMatchObject({
			name: "ReauthRequiredError",
			reason: "revoked",
		});
	});

	it.each(["invalid_client", "unauthorized_client"])("maps %s to misconfigured", async (error) => {
		await connect("work");
		googleAnswers(401, { error });
		await expect(getAccessToken(testEnv, CLIENT, "work")).rejects.toMatchObject({ name: "MisconfiguredError" });
	});

	it("maps 429 to upstream_unavailable (rate_limited)", async () => {
		await connect("work");
		googleAnswers(429, {});
		await expect(getAccessToken(testEnv, CLIENT, "work")).rejects.toMatchObject({
			name: "UpstreamUnavailableError",
			reason: "rate_limited",
		});
	});

	it("maps a 5xx, a network failure, and a 200 with no token to upstream_unavailable", async () => {
		await connect("work");
		googleAnswers(503, { error: "backendError" });
		await expect(getAccessToken(testEnv, CLIENT, "work")).rejects.toMatchObject({ detail: "backendError" });

		vi.restoreAllMocks();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network"));
		await expect(getAccessToken(testEnv, CLIENT, "work")).rejects.toMatchObject({ name: "UpstreamUnavailableError" });

		vi.restoreAllMocks();
		googleAnswers(200, {});
		await expect(getAccessToken(testEnv, CLIENT, "work")).rejects.toMatchObject({ name: "UpstreamUnavailableError" });
	});

	it("throws misconfigured when the encryption key is missing", async () => {
		const { TOKEN_ENCRYPTION_KEY: _, ...env } = testEnv;
		await expect(getAccessToken(env, CLIENT, "work")).rejects.toMatchObject({
			message: "misconfigured: TOKEN_ENCRYPTION_KEY",
		});
	});
});
