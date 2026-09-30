// Google sign-in for the gate: a bare OpenID identity grant (`openid email`,
// nothing else) that proves who is talking to the Worker. It is a different
// grant from the per-account mailbox grants and must never carry their scopes.
// One path serves both purposes: signing in to the admin UI, and approving an
// MCP connector at /authorize.
//
// On the stop-list (AGENTS.md): the scope list lives here.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { MisconfiguredError, UpstreamUnavailableError } from "./errors.js";
import { GOOGLE_TOKEN_URL, type GoogleClient } from "./google.js";
import { base64url, randomToken } from "./session.js";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** The gate grant's whole scope list. Adding to it would give the door credential mailbox powers. */
export const SIGN_IN_SCOPES = ["openid", "email"] as const;
const PENDING_TTL_SECONDS = 600;
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const LABEL = "Google sign-in";

/** The redirect URI to register with the Google OAuth client. */
export function googleRedirectUri(origin: string): string {
	return `${origin}/signin/callback`;
}

export interface PendingSignIn {
	purpose: "admin" | "mcp";
	oauthReqInfo?: AuthRequest;
	codeVerifier: string;
	nonce: string;
}

export interface Identity {
	sub: string;
	email: string;
}

/** Stores a pending sign-in and returns the Google URL to send the browser to. */
export async function startSignIn(
	kv: KVNamespace,
	origin: string,
	client: GoogleClient,
	purpose: PendingSignIn["purpose"],
	oauthReqInfo?: AuthRequest,
): Promise<string> {
	const state = randomToken();
	const pending: PendingSignIn = { purpose, oauthReqInfo, codeVerifier: randomToken(), nonce: randomToken() };
	await kv.put(`signin:${state}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS });

	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.codeVerifier));
	const url = new URL(GOOGLE_AUTH_URL);
	url.search = new URLSearchParams({
		client_id: client.clientId,
		redirect_uri: googleRedirectUri(origin),
		response_type: "code",
		scope: SIGN_IN_SCOPES.join(" "),
		prompt: "select_account",
		state,
		nonce: pending.nonce,
		code_challenge: base64url(new Uint8Array(digest)),
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

/** Looks up and deletes a pending sign-in: a state can only be used once. Null if unknown or expired. */
export async function takePending(kv: KVNamespace, state: string | null): Promise<PendingSignIn | null> {
	if (!state) return null;
	const pending = await kv.get<PendingSignIn>(`signin:${state}`, "json");
	if (!pending) return null;
	await kv.delete(`signin:${state}`);
	return pending;
}

function decodePayload(idToken: string): Record<string, unknown> | null {
	const part = idToken.split(".")[1];
	if (!part) return null;
	try {
		const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/"));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Exchanges an authorization code at Google's token endpoint. Returns the
 * response body, or null when Google rejects the code (invalid_grant); throws
 * MisconfiguredError or UpstreamUnavailableError for the rest. `label` names
 * the grant in those errors. Shared with src/connect.ts.
 */
export async function exchangeCode(
	origin: string,
	client: GoogleClient,
	codeVerifier: string,
	code: string,
	label: string = LABEL,
): Promise<Record<string, unknown> | null> {
	let response: Response;
	try {
		response = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: codeVerifier,
				redirect_uri: googleRedirectUri(origin),
				client_id: client.clientId,
				client_secret: client.clientSecret,
			}),
		});
	} catch {
		throw new UpstreamUnavailableError(label);
	}

	let body: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = await response.json();
		if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
	} catch {
		body = null;
	}

	if (!response.ok) {
		const errorCode = typeof body?.error === "string" ? body.error : undefined;
		if (errorCode === "invalid_client" || errorCode === "unauthorized_client") {
			throw new MisconfiguredError(["Google OAuth client"], `Google rejected it (${errorCode})`);
		}
		if (errorCode === "invalid_grant") return null;
		if (response.status === 429) throw new UpstreamUnavailableError(label, "rate_limited");
		throw new UpstreamUnavailableError(label, "outage", errorCode ?? `HTTP ${response.status}`);
	}
	if (!body) throw new UpstreamUnavailableError(label);
	return body;
}

/** Checks an id_token's claims against this client and nonce. Null if any check fails. Shared with src/connect.ts. */
export function identityFromIdToken(idToken: string, client: GoogleClient, nonce: string): Identity | null {
	const claims = decodePayload(idToken);
	if (!claims) return null;
	const { iss, aud, exp, nonce: claimedNonce, email_verified: verified, sub, email } = claims;
	if (typeof iss !== "string" || !ISSUERS.includes(iss)) return null;
	if (aud !== client.clientId) return null;
	if (typeof exp !== "number" || exp * 1000 <= Date.now()) return null;
	if (claimedNonce !== nonce) return null;
	if (verified !== true) return null;
	if (typeof sub !== "string" || !sub || typeof email !== "string" || !email) return null;
	return { sub, email };
}

/**
 * Exchanges the code for an id_token and checks its claims. Returns null when
 * the sign-in itself is bad (a rejected code, or claims that don't check
 * out); throws MisconfiguredError or UpstreamUnavailableError for the rest.
 * The id_token comes straight from Google over TLS, so its signature isn't
 * verified (OIDC core 3.1.3.7). Google's access token is never read.
 */
export async function verifyCallback(
	origin: string,
	client: GoogleClient,
	pending: PendingSignIn,
	code: string,
): Promise<Identity | null> {
	const body = await exchangeCode(origin, client, pending.codeVerifier, code);
	if (!body) return null;
	const idToken = body.id_token;
	if (typeof idToken !== "string" || idToken.length === 0) throw new UpstreamUnavailableError(LABEL);
	return identityFromIdToken(idToken, client, pending.nonce);
}
