import { describe, expect, it } from "vitest";
import type { Account } from "../src/accounts.js";
import { MisconfiguredError, ReauthRequiredError, UpstreamUnavailableError } from "../src/errors.js";
import { fanOut, renderFanOut } from "../src/fanout.js";

function account(email: string, label = email): Account {
	return { email, sub: email, label, connectedAt: "2026-01-01T00:00:00.000Z" };
}

const OK = account("ok@example.com", "Work");
const REVOKED = account("shared@example.com", "Shared");
const DOWN = account("down@example.com");

function text(result: ReturnType<typeof renderFanOut>): string {
	return (result.content[0] as { text: string }).text;
}

async function run(accounts: Account[]) {
	const outcome = await fanOut(accounts, async (a) => {
		if (a === REVOKED) throw new ReauthRequiredError(a.email, "revoked");
		if (a === DOWN) throw new UpstreamUnavailableError(a.email);
		return "connected";
	});
	return renderFanOut(outcome, (value) => value);
}

describe("fanOut and renderFanOut", () => {
	it("names every unreachable account before any result, revoked first", async () => {
		const result = await run([DOWN, OK, REVOKED]);
		const lines = text(result).split("\n");
		expect(lines[0]).toBe("Partial result: 2 of 3 accounts could not be reached.");
		expect(lines[1]).toContain("Shared (shared@example.com): reauth_required");
		expect(lines[1]).toContain("Reconnect");
		expect(lines[1]).toContain("remove");
		expect(lines[2]).toContain("down@example.com: upstream_unavailable");
		expect(lines[2]).toContain("Try again");
		expect(lines[2]).not.toContain("Reconnect");
		expect(text(result).indexOf("Work (ok@example.com): connected")).toBeGreaterThan(text(result).indexOf("Try again"));
		expect(result.isError).toBeUndefined();
	});

	it("states complete coverage when everything answered", async () => {
		const result = await run([OK, account("b@example.com"), account("c@example.com")]);
		expect(text(result).split("\n")[0]).toBe("All 3 accounts answered.");
		expect(result.isError).toBeUndefined();
	});

	it("is an error with no results when every account failed", async () => {
		const result = await run([REVOKED, DOWN]);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Partial result: 2 of 2");
		expect(text(result)).not.toContain(": connected");
	});

	it("is an error naming the admin page when no accounts are connected", async () => {
		const result = await run([]);
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("gmux admin page");
	});

	it("rethrows an unrecognised error and a MisconfiguredError", async () => {
		await expect(
			fanOut([OK, DOWN], async (a) => {
				if (a === DOWN) throw new TypeError("bug");
				return 1;
			}),
		).rejects.toThrow(TypeError);
		await expect(
			fanOut([OK], async () => {
				throw new MisconfiguredError(["GOOGLE_CLIENT"]);
			}),
		).rejects.toThrow(MisconfiguredError);
	});

	it("keeps input order when calls resolve in reverse, and doesn't repeat a label equal to the email", async () => {
		const accounts = [account("a@example.com"), account("b@example.com"), account("c@example.com")];
		const outcome = await fanOut(accounts, async (a) => {
			await new Promise((resolve) => setTimeout(resolve, 30 - accounts.indexOf(a) * 10));
			return "x";
		});
		const lines = text(renderFanOut(outcome, (value) => value)).split("\n");
		expect(lines.filter(Boolean)).toEqual([
			"All 3 accounts answered.",
			"a@example.com: x",
			"b@example.com: x",
			"c@example.com: x",
		]);
	});
});
