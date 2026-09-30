// The mailbox grant: connecting one Google account's mail to gmux. A different
// grant from the gate's sign-in (src/signin.ts, `openid email` only), with its
// own pending-state prefix (`connect:<state>`), its own scope list and its own
// handler. It shares only the redirect URI, because that's the one address
// deployers registered in Google Cloud Console. This file calls no Gmail API.
//
// On the stop-list (AGENTS.md): the scope list (MAIL_SCOPES, in
// src/accounts.ts, plus `openid email` here), and the dispatch from
// /signin/callback that reaches it.

import { MAIL_SCOPES, normalizeEmail, saveAccount } from "./accounts.js";
import { readEncryptionKey } from "./config.js";
import type { Env } from "./env.js";
import { UpstreamUnavailableError } from "./errors.js";
import type { GoogleClient } from "./google.js";
import { base64url, randomToken, type Session } from "./session.js";
import { exchangeCode, GOOGLE_AUTH_URL, googleRedirectUri, identityFromIdToken } from "./signin.js";
import { writeRefreshToken } from "./token-store.js";

/** `openid email` only says which account was connected; the rest is what gmux reads and drafts with. */
export const CONNECT_SCOPES = ["openid", "email", ...MAIL_SCOPES] as const;
const CONNECT_TTL_SECONDS = 600;
const LABEL = "Google account connect";

export interface PendingConnect {
	/** The owner session that started this; only that session may finish it. */
	sub: string;
	codeVerifier: string;
	nonce: string;
	/** Set on Reconnect: the account being repaired. */
	expectEmail?: string;
}

export type ConnectResult =
	| { kind: "connected"; email: string; expectedEmail?: string }
	| { kind: "missing_scopes" }
	| { kind: "failed" };

/** Stores a pending connect and returns the Google URL to send the browser to. */
export async function startConnect(
	kv: KVNamespace,
	origin: string,
	client: GoogleClient,
	session: Session,
	reconnectEmail?: string,
): Promise<string> {
	const state = randomToken();
	const expectEmail = reconnectEmail ? normalizeEmail(reconnectEmail) : undefined;
	const pending: PendingConnect = { sub: session.sub, codeVerifier: randomToken(), nonce: randomToken(), expectEmail };
	await kv.put(`connect:${state}`, JSON.stringify(pending), { expirationTtl: CONNECT_TTL_SECONDS });

	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.codeVerifier));
	const params = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: googleRedirectUri(origin),
		response_type: "code",
		scope: CONNECT_SCOPES.join(" "),
		// offline + consent so Google always hands back a refresh token.
		access_type: "offline",
		prompt: "consent",
		state,
		nonce: pending.nonce,
		code_challenge: base64url(new Uint8Array(digest)),
		code_challenge_method: "S256",
	});
	if (expectEmail) params.set("login_hint", expectEmail);
	const url = new URL(GOOGLE_AUTH_URL);
	url.search = params.toString();
	return url.toString();
}

/**
 * Looks up and deletes a pending connect: a state can only be used once.
 * Null if it isn't a connect state at all (so the caller can treat it as a
 * sign-in), or has expired.
 */
export async function takeConnect(kv: KVNamespace, state: string | null): Promise<PendingConnect | null> {
	if (!state) return null;
	const pending = await kv.get<PendingConnect>(`connect:${state}`, "json");
	if (!pending) return null;
	await kv.delete(`connect:${state}`);
	return pending;
}

/**
 * Exchanges the code and, if everything checks out, stores the encrypted
 * refresh token and the registry record. Stores nothing on any refusal.
 * Throws MisconfiguredError or UpstreamUnavailableError like verifyCallback.
 */
export async function finishConnect(
	env: Env,
	origin: string,
	client: GoogleClient,
	pending: PendingConnect,
	code: string,
): Promise<ConnectResult> {
	const encryptionKey = readEncryptionKey(env);
	const body = await exchangeCode(origin, client, pending.codeVerifier, code, LABEL);
	if (!body) return { kind: "failed" };

	const idToken = body.id_token;
	if (typeof idToken !== "string" || idToken.length === 0) throw new UpstreamUnavailableError(LABEL);
	const identity = identityFromIdToken(idToken, client, pending.nonce);
	if (!identity) return { kind: "failed" };

	// Google's granular consent lets the user untick boxes.
	const granted = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [];
	if (!MAIL_SCOPES.every((scope) => granted.includes(scope))) return { kind: "missing_scopes" };

	const refreshToken = body.refresh_token;
	if (typeof refreshToken !== "string" || refreshToken.length === 0) return { kind: "failed" };

	const email = normalizeEmail(identity.email);
	const connectedAt = new Date().toISOString();
	await writeRefreshToken(env.GMUX_KV, encryptionKey, email, { refreshToken, email, scopes: granted, connectedAt });
	await saveAccount(env.GMUX_KV, { email, sub: identity.sub, connectedAt });

	// A reconnect that came back as a different Google account still connects
	// that account; it never overwrites the one being repaired.
	const expected = pending.expectEmail;
	return expected && expected !== email
		? { kind: "connected", email, expectedEmail: expected }
		: { kind: "connected", email };
}
