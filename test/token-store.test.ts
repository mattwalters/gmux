import { describe, expect, it } from "vitest";
import { deleteRefreshToken, type RefreshRecord, readRefreshToken, writeRefreshToken } from "../src/token-store.js";
import { testEnv } from "./helpers.js";

const KEY = testEnv.TOKEN_ENCRYPTION_KEY as string;
const OTHER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // a different, valid 32-byte key
const KV = testEnv.GMUX_KV;

const RECORD: RefreshRecord = {
	refreshToken: "1//test-refresh-token",
	email: "work@example.com",
	scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
	connectedAt: "2026-01-01T00:00:00.000Z",
};

async function expectReauth(promise: Promise<unknown>, reason: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({ message: expect.stringMatching(/^reauth_required: /), reason });
}

describe("token store", () => {
	it("round-trips a record", async () => {
		await writeRefreshToken(KV, KEY, "work", RECORD);
		expect(await readRefreshToken(KV, KEY, "work")).toEqual(RECORD);
	});

	it("stores ciphertext only", async () => {
		await writeRefreshToken(KV, KEY, "work", RECORD);
		const raw = (await KV.get("refresh:work")) as string;
		expect(JSON.parse(raw)).toMatchObject({ v: 1, iv: expect.any(String), ct: expect.any(String) });
		expect(raw).not.toContain(RECORD.refreshToken);
		expect(raw).not.toContain(RECORD.email);
	});

	it("uses a fresh IV on every write", async () => {
		await writeRefreshToken(KV, KEY, "work", RECORD);
		const first = JSON.parse((await KV.get("refresh:work")) as string);
		await writeRefreshToken(KV, KEY, "work", RECORD);
		const second = JSON.parse((await KV.get("refresh:work")) as string);
		expect(first.iv).not.toBe(second.iv);
	});

	it("throws not_connected, never an empty result, when there's no record", async () => {
		await expectReauth(readRefreshToken(KV, KEY, "never-connected"), "not_connected");
	});

	it("throws unreadable under a different key", async () => {
		await writeRefreshToken(KV, KEY, "work", RECORD);
		await expectReauth(readRefreshToken(KV, OTHER_KEY, "work"), "unreadable");
	});

	it("throws unreadable for a ciphertext copied from another account", async () => {
		await writeRefreshToken(KV, KEY, "work", RECORD);
		await KV.put("refresh:home", (await KV.get("refresh:work")) as string);
		await expectReauth(readRefreshToken(KV, KEY, "home"), "unreadable");
	});

	it("throws unreadable for garbage", async () => {
		await KV.put("refresh:work", "not json");
		await expectReauth(readRefreshToken(KV, KEY, "work"), "unreadable");
	});

	it("deletes a record", async () => {
		await writeRefreshToken(KV, KEY, "work", RECORD);
		await deleteRefreshToken(KV, "work");
		await expectReauth(readRefreshToken(KV, KEY, "work"), "not_connected");
	});
});
