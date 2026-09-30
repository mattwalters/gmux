import { describe, expect, it } from "vitest";
import { parseGoogleClientForm } from "../src/config.js";

const ID = "abc-123.apps.googleusercontent.com";

describe("parseGoogleClientForm", () => {
	it("trims and accepts a valid pair", () => {
		expect(parseGoogleClientForm(` ${ID} `, " GOCSPX-abc_123 ")).toEqual({
			clientId: ID,
			clientSecret: "GOCSPX-abc_123",
		});
	});

	it.each([
		["a missing ID", undefined, "secret"],
		["an ID without Google's suffix", "abc-123", "secret"],
		["an over-long ID", `${"a".repeat(250)}.apps.googleusercontent.com`, "secret"],
		["a missing secret", ID, ""],
		["a secret with whitespace inside", ID, "two words"],
		["an over-long secret", ID, "s".repeat(257)],
		["a non-string secret", ID, new File([], "x")],
	])("rejects %s", (_name, id, secret) => {
		expect(parseGoogleClientForm(id, secret)).toHaveProperty("error");
	});

	it("never repeats the secret in its message", () => {
		const result = parseGoogleClientForm("nope", "super secret");
		expect(JSON.stringify(result)).not.toContain("super");
		const other = parseGoogleClientForm(ID, "two words");
		expect(JSON.stringify(other)).not.toContain("two");
	});
});
