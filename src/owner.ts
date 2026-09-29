// The owner record: the first Google account to sign in after the client is
// configured (trust on first use, GMX-2). The only module that touches
// `config:owner`. There is deliberately no function that overwrites or
// deletes it: changing the owner means deleting the key in the Cloudflare
// dashboard, so nothing in the app can silently hand the instance over.
//
// On the stop-list (AGENTS.md): a change here waits for a human to merge it.

import { MisconfiguredError } from "./errors.js";

export const OWNER_KEY = "config:owner";

export interface Owner {
	/** Google's stable account id. Identity is keyed on this, never on the email. */
	sub: string;
	/** Shown on every page. */
	email: string;
	claimedAt: string;
}

const UNREADABLE = "it isn't readable; delete config:owner in the Cloudflare dashboard to start over";

/**
 * The current owner, or null when the instance is unclaimed. A record that's
 * present but unreadable throws rather than reading as "unclaimed", which
 * would let the next sign-in take over.
 */
export async function readOwner(kv: KVNamespace): Promise<Owner | null> {
	const raw = await kv.get(OWNER_KEY);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<Owner> | null;
		if (typeof parsed?.sub === "string" && typeof parsed.email === "string" && parsed.sub && parsed.email) {
			return { sub: parsed.sub, email: parsed.email, claimedAt: String(parsed.claimedAt ?? "") };
		}
	} catch {
		// falls through to the error below
	}
	throw new MisconfiguredError(["owner record"], UNREADABLE);
}

/**
 * Claims the instance for `identity` if nobody has, and returns whoever the
 * owner is afterwards: compare its `sub` to know whether the claim was yours.
 * Best-effort, not atomic: KV has no compare-and-swap, so the claim is
 * written and read back, which narrows the race between two near-simultaneous
 * first sign-ins without closing it.
 */
export async function claimOwnerIfUnclaimed(kv: KVNamespace, identity: { sub: string; email: string }): Promise<Owner> {
	const existing = await readOwner(kv);
	if (existing) return existing;
	const claim: Owner = { sub: identity.sub, email: identity.email, claimedAt: new Date().toISOString() };
	await kv.put(OWNER_KEY, JSON.stringify(claim));
	const stored = await readOwner(kv);
	if (!stored) throw new MisconfiguredError(["owner record"], "it was not stored");
	return stored;
}
