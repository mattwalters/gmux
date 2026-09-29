// The admin session: a random id in a cookie, and `session:<id>` in GMUX_KV.
// Nothing is signed, so nothing derives from TOKEN_ENCRYPTION_KEY. A session
// is only good while its `sub` is still the owner's, so clearing the owner in
// the Cloudflare dashboard ends every session at once.

import type { Owner } from "./owner.js";

export const SESSION_COOKIE = "__Host-gmux_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface Session {
	sub: string;
	email: string;
	/** Bound to this session; every state-changing form must echo it. */
	csrf: string;
}

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 32 random bytes, base64url. */
export function randomToken(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function createSession(
	kv: KVNamespace,
	identity: { sub: string; email: string },
): Promise<{ id: string; session: Session }> {
	const id = randomToken();
	const session: Session = { sub: identity.sub, email: identity.email, csrf: randomToken() };
	await kv.put(`session:${id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL_SECONDS });
	return { id, session };
}

/** The session for a cookie value, or null if it's absent, expired, unreadable or no longer the owner's. */
export async function readSession(
	kv: KVNamespace,
	id: string | undefined,
	owner: Owner | null,
): Promise<Session | null> {
	if (!id || !owner) return null;
	const session = await kv.get<Session>(`session:${id}`, "json");
	if (!session || session.sub !== owner.sub) return null;
	return session;
}

export async function destroySession(kv: KVNamespace, id: string): Promise<void> {
	await kv.delete(`session:${id}`);
}
