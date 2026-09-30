import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	accountHealth,
	getAccount,
	listAccounts,
	MAIL_SCOPES,
	REQUIRED_SCOPES,
	removeAccount,
	renameAccount,
	saveAccount,
} from "../src/accounts.js";
import { writeRefreshToken } from "../src/token-store.js";
import { GOOGLE_CLIENT, resetKv, testEnv } from "./helpers.js";

const KV = testEnv.GMUX_KV;
const KEY = testEnv.TOKEN_ENCRYPTION_KEY as string;
const WHEN = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

function connect(email: string, scopes: string[] = [...REQUIRED_SCOPES]) {
	return writeRefreshToken(KV, KEY, email, { refreshToken: "1//refresh", email, scopes, connectedAt: WHEN });
}

function tokenEndpoint(status: number, body: unknown) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body, { status }));
}

describe("registry", () => {
	it("keys accounts by lower-cased email and defaults the label to it", async () => {
		const saved = await saveAccount(KV, { email: "Work@Example.com", sub: "1", connectedAt: WHEN });
		expect(saved).toEqual({ email: "work@example.com", sub: "1", label: "work@example.com", connectedAt: WHEN });
		expect(await getAccount(KV, "WORK@example.com")).toEqual(saved);
		expect(await KV.get("account:work@example.com")).not.toBeNull();
	});

	it("lists accounts sorted by label", async () => {
		await saveAccount(KV, { email: "b@example.com", sub: "2", connectedAt: WHEN });
		await saveAccount(KV, { email: "a@example.com", sub: "1", connectedAt: WHEN });
		await renameAccount(KV, "b@example.com", "1st");
		expect((await listAccounts(KV)).map((account) => account.email)).toEqual(["b@example.com", "a@example.com"]);
	});

	it("renames with a trimmed label, resets an empty one, and refuses a long one", async () => {
		await saveAccount(KV, { email: "a@example.com", sub: "1", connectedAt: WHEN });
		expect(await renameAccount(KV, "a@example.com", "  Work  ")).toBe("ok");
		expect((await getAccount(KV, "a@example.com"))?.label).toBe("Work");
		expect(await renameAccount(KV, "a@example.com", "   ")).toBe("ok");
		expect((await getAccount(KV, "a@example.com"))?.label).toBe("a@example.com");
		expect(await renameAccount(KV, "a@example.com", "x".repeat(65))).toBe("invalid");
		expect(await renameAccount(KV, "nobody@example.com", "x")).toBe("not_found");
	});

	it("keeps the label when the account is saved again", async () => {
		await saveAccount(KV, { email: "a@example.com", sub: "1", connectedAt: WHEN });
		await renameAccount(KV, "a@example.com", "Work");
		const again = await saveAccount(KV, { email: "a@example.com", sub: "1", connectedAt: "2026-02-01T00:00:00.000Z" });
		expect(again.label).toBe("Work");
		expect(again.connectedAt).toBe("2026-02-01T00:00:00.000Z");
	});

	it("never skips an unreadable record", async () => {
		await KV.put("account:broken@example.com", "{not json");
		await expect(listAccounts(KV)).rejects.toMatchObject({ name: "MisconfiguredError" });
		await KV.put("account:broken@example.com", JSON.stringify({ email: 1 }));
		await expect(listAccounts(KV)).rejects.toMatchObject({ name: "MisconfiguredError" });
	});

	it("removes both the registry record and the token", async () => {
		await saveAccount(KV, { email: "a@example.com", sub: "1", connectedAt: WHEN });
		await connect("a@example.com");
		await removeAccount(KV, "A@example.com");
		expect(await KV.get("account:a@example.com")).toBeNull();
		expect(await KV.get("refresh:a@example.com")).toBeNull();
	});
});

describe("accountHealth", () => {
	const health = () => accountHealth(testEnv, GOOGLE_CLIENT, "a@example.com");

	it("is ok when the refresh works and every mail scope is there", async () => {
		await connect("a@example.com");
		tokenEndpoint(200, { access_token: "ya29.x" });
		expect(await health()).toEqual({ state: "ok" });
	});

	it("maps invalid_grant to reauth", async () => {
		await connect("a@example.com");
		tokenEndpoint(400, { error: "invalid_grant" });
		expect(await health()).toMatchObject({
			state: "reauth_required",
			sentence: expect.stringContaining("reconnecting"),
		});
	});

	it.each([429, 500])("maps %i to upstream unavailable", async (status) => {
		await connect("a@example.com");
		tokenEndpoint(status, {});
		expect(await health()).toMatchObject({ state: "upstream_unavailable" });
	});

	it("maps invalid_client to misconfigured", async () => {
		await connect("a@example.com");
		tokenEndpoint(401, { error: "invalid_client" });
		expect(await health()).toMatchObject({ state: "misconfigured" });
	});

	it("maps a missing token to reauth", async () => {
		const fetchSpy = tokenEndpoint(200, {});
		expect(await health()).toMatchObject({
			state: "reauth_required",
			sentence: expect.stringContaining("hasn't been connected"),
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("maps a grant missing a mail scope to reauth", async () => {
		await connect("a@example.com");
		tokenEndpoint(200, { access_token: "ya29.x", scope: MAIL_SCOPES[0] });
		expect(await health()).toMatchObject({ state: "reauth_required" });
	});

	it("maps a mail-only grant, from before Drive, to reauth", async () => {
		await connect("a@example.com", [...MAIL_SCOPES]);
		tokenEndpoint(200, { access_token: "ya29.x", scope: MAIL_SCOPES.join(" ") });
		expect(await health()).toMatchObject({ state: "reauth_required" });
	});

	it("rethrows an error that isn't one of the three classes", async () => {
		const brokenEnv = { ...testEnv, GMUX_KV: undefined as never };
		await expect(accountHealth(brokenEnv, GOOGLE_CLIENT, "a@example.com")).rejects.toThrow(TypeError);
	});
});
