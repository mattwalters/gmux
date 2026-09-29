// Fail-closed configuration. gmux boots with nothing configured - a fresh
// deploy has no Google client and may have no encryption key - and serves the
// setup page instead of erroring (AGENTS.md's "Boots unconfigured"). Anything
// that actually needs a piece of config asks for it here, and gets either
// the value or a MisconfiguredError naming what's missing.

import type { Env } from "./env.js";
import { MisconfiguredError } from "./errors.js";
import type { GoogleClient } from "./google.js";

/**
 * GMUX_KV key the setup wizard (GMX-3) writes the Google OAuth client to, as
 * JSON `{clientId, clientSecret}`. Until then it's put there by hand.
 */
export const GOOGLE_CLIENT_KEY = "config:google-client";

/** True only for standard base64 (not the url-safe variant) that decodes to exactly 32 bytes. */
export function decodesTo32Bytes(value: string): boolean {
	let binary: string;
	try {
		binary = atob(value);
	} catch {
		return false;
	}
	return binary.length === 32;
}

/** TOKEN_ENCRYPTION_KEY, validated. Throws MisconfiguredError when it's missing or isn't 32 base64 bytes. */
export function readEncryptionKey(env: Pick<Env, "TOKEN_ENCRYPTION_KEY">): string {
	const key = env.TOKEN_ENCRYPTION_KEY?.trim();
	if (!key || !decodesTo32Bytes(key)) throw new MisconfiguredError(["TOKEN_ENCRYPTION_KEY"]);
	return key;
}

/** The Google OAuth client. Throws MisconfiguredError when it's missing or isn't `{clientId, clientSecret}`. */
export async function readGoogleClient(env: Pick<Env, "GMUX_KV">): Promise<GoogleClient> {
	const raw = await env.GMUX_KV.get(GOOGLE_CLIENT_KEY);
	if (raw !== null) {
		try {
			const parsed = JSON.parse(raw) as Partial<GoogleClient> | null;
			const { clientId, clientSecret } = parsed ?? {};
			if (typeof clientId === "string" && clientId && typeof clientSecret === "string" && clientSecret) {
				return { clientId, clientSecret };
			}
		} catch {
			// falls through to the error below
		}
	}
	throw new MisconfiguredError(["Google OAuth client"]);
}

export interface SetupState {
	encryptionKey: boolean;
	googleClient: boolean;
}

/** What's configured so far. Never throws: this is what the setup page is drawn from. */
export async function readSetupState(env: Env): Promise<SetupState> {
	let encryptionKey = true;
	try {
		readEncryptionKey(env);
	} catch {
		encryptionKey = false;
	}
	const googleClient = (await env.GMUX_KV.get(GOOGLE_CLIENT_KEY)) !== null;
	return { encryptionKey, googleClient };
}

export function isConfigured(state: SetupState): boolean {
	return state.encryptionKey && state.googleClient;
}
