import { afterEach, describe, expect, it } from "vitest";
import * as ownerModule from "../src/owner.js";
import { claimOwnerIfUnclaimed, OWNER_KEY, readOwner } from "../src/owner.js";
import { resetKv, testEnv } from "./helpers.js";

const kv = testEnv.GMUX_KV;

afterEach(resetKv);

describe("owner record", () => {
	it("is null until someone claims it", async () => {
		expect(await readOwner(kv)).toBeNull();
	});

	it("goes to the first claimant and stays there", async () => {
		const first = await claimOwnerIfUnclaimed(kv, { sub: "1", email: "a@example.com" });
		expect(first).toMatchObject({ sub: "1", email: "a@example.com" });
		const second = await claimOwnerIfUnclaimed(kv, { sub: "2", email: "b@example.com" });
		expect(second.sub).toBe("1");
		expect(await readOwner(kv)).toMatchObject({ sub: "1", email: "a@example.com" });
	});

	it("throws on an unreadable record instead of reading as unclaimed", async () => {
		await kv.put(OWNER_KEY, "{}");
		await expect(readOwner(kv)).rejects.toMatchObject({ name: "MisconfiguredError" });
		await expect(claimOwnerIfUnclaimed(kv, { sub: "2", email: "b@example.com" })).rejects.toMatchObject({
			name: "MisconfiguredError",
		});
	});

	it("offers no way to overwrite or delete the owner", () => {
		expect(Object.keys(ownerModule).sort()).toEqual(["OWNER_KEY", "claimOwnerIfUnclaimed", "readOwner"]);
	});
});
