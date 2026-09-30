// Fail-closed configuration. gmux boots with nothing configured - a fresh
// deploy has no Google client and may have no encryption key - and serves the
// setup page instead of erroring (AGENTS.md's "Boots unconfigured"). Anything
// that actually needs a piece of config asks for it here, and gets either
// the value or a MisconfiguredError naming what's missing.

import type { Env } from "./env.js";
import { MisconfiguredError } from "./errors.js";
import type { GoogleClient } from "./google.js";

/**
 * GMUX_KV key the setup wizard writes the Google OAuth client to, as JSON
 * `{clientId, clientSecret}`.
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

const MAX_FIELD_LENGTH = 256;
const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

/**
 * Validates the setup form's client ID and secret. The messages are for the
 * person typing, and never repeat the secret.
 */
export function parseGoogleClientForm(clientId: unknown, clientSecret: unknown): GoogleClient | { error: string } {
	const id = typeof clientId === "string" ? clientId.trim() : "";
	const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
	if (!id) return { error: "Enter the client ID." };
	if (id.length > MAX_FIELD_LENGTH || !id.endsWith(CLIENT_ID_SUFFIX)) {
		return { error: `That doesn't look like a client ID. It ends with ${CLIENT_ID_SUFFIX}.` };
	}
	if (!secret) return { error: "Enter the client secret." };
	if (secret.length > MAX_FIELD_LENGTH || /\s/.test(secret)) {
		return { error: "That doesn't look like a client secret. Copy it again from Google, with no spaces." };
	}
	return { clientId: id, clientSecret: secret };
}

/** Stores the Google OAuth client. A KV failure propagates. */
export async function writeGoogleClient(env: Pick<Env, "GMUX_KV">, client: GoogleClient): Promise<void> {
	const { clientId, clientSecret } = client;
	await env.GMUX_KV.put(GOOGLE_CLIENT_KEY, JSON.stringify({ clientId, clientSecret }));
}

export interface SetupState {
	encryptionKey: boolean;
	googleClient: boolean;
	/** The configured client's ID, for display. Never the secret. Absent when the record is malformed. */
	googleClientId?: string;
}

/** What's configured so far. Never throws: this is what the setup page is drawn from. */
export async function readSetupState(env: Env): Promise<SetupState> {
	let encryptionKey = true;
	try {
		readEncryptionKey(env);
	} catch {
		encryptionKey = false;
	}
	const raw = await env.GMUX_KV.get(GOOGLE_CLIENT_KEY);
	let googleClientId: string | undefined;
	try {
		const id = (JSON.parse(raw ?? "null") as Partial<GoogleClient> | null)?.clientId;
		if (typeof id === "string" && id) googleClientId = id;
	} catch {
		// a malformed record has no ID to show
	}
	return { encryptionKey, googleClient: raw !== null, googleClientId };
}

export function isConfigured(state: SetupState): boolean {
	return state.encryptionKey && state.googleClient;
}
