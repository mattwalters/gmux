// Access tokens on demand, and the one place a Google token-endpoint response
// is mapped to src/errors.ts's three classes - the same mapping ops-mail
// uses. No caching: a refresh is one fast call.

import { readEncryptionKey } from "./config.js";
import type { Env } from "./env.js";
import { MisconfiguredError, ReauthRequiredError, UpstreamUnavailableError } from "./errors.js";
import { readRefreshToken, writeRefreshToken } from "./token-store.js";

/** The deployment's own Google OAuth client. Configured by the setup wizard (GMX-3). */
export interface GoogleClient {
	clientId: string;
	clientSecret: string;
}

export interface AccessTokenResult {
	accessToken: string;
	/**
	 * The scopes this grant has now: the refresh response's own `scope` when
	 * Google sends one, otherwise the scopes recorded at connect time.
	 */
	scopes: string[];
}

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Decrypts `account`'s stored refresh token and exchanges it for a fresh
 * access token. Exact error mapping:
 *
 * - no record, or an unreadable one -> ReauthRequiredError (from the token store)
 * - 400 invalid_grant or invalid_scope -> ReauthRequiredError "revoked"
 * - invalid_client or unauthorized_client -> MisconfiguredError - reconnecting would not help
 * - 429 -> UpstreamUnavailableError "rate_limited"
 * - anything else (another status, a network throw, or 200 with no access_token) -> UpstreamUnavailableError
 *
 * If Google returns a new refresh_token (rare), it is re-encrypted and stored.
 */
export async function getAccessToken(env: Env, client: GoogleClient, account: string): Promise<AccessTokenResult> {
	const encryptionKey = readEncryptionKey(env);
	const record = await readRefreshToken(env.GMUX_KV, encryptionKey, account);

	let response: Response;
	try {
		response = await fetch(GOOGLE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: record.refreshToken,
				client_id: client.clientId,
				client_secret: client.clientSecret,
			}),
		});
	} catch {
		throw new UpstreamUnavailableError(account);
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
		if (errorCode === "invalid_grant" || errorCode === "invalid_scope") {
			throw new ReauthRequiredError(account, "revoked");
		}
		if (errorCode === "invalid_client" || errorCode === "unauthorized_client") {
			throw new MisconfiguredError(["Google OAuth client"], `Google rejected it (${errorCode})`);
		}
		if (response.status === 429) throw new UpstreamUnavailableError(account, "rate_limited");
		throw new UpstreamUnavailableError(account, "outage", errorCode ?? `HTTP ${response.status}`);
	}

	const accessToken = body?.access_token;
	if (typeof accessToken !== "string" || accessToken.length === 0) throw new UpstreamUnavailableError(account);

	const scope = body?.scope;
	const scopes = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : record.scopes;

	const newRefreshToken = body?.refresh_token;
	if (typeof newRefreshToken === "string" && newRefreshToken.length > 0) {
		await writeRefreshToken(env.GMUX_KV, encryptionKey, account, { ...record, refreshToken: newRefreshToken });
	}

	return { accessToken, scopes };
}
