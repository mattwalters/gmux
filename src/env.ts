import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
	// The OAuth library's own namespace: client registrations, grants and
	// connector tokens. Never read or written directly.
	OAUTH_KV: KVNamespace;
	// Everything of gmux's own: encrypted refresh tokens (refresh:*), the
	// Google OAuth client (config:google-client, GMX-3), the owner
	// (config:owner), admin sessions (session:*), and short-lived sign-in and
	// consent records (signin:*, consent:*). Separate from OAUTH_KV so it can be inspected or
	// wiped without touching connector grants.
	GMUX_KV: KVNamespace;
	// Injected by OAuthProvider at request time; not a real binding.
	OAUTH_PROVIDER: OAuthHelpers;
	// Optional on purpose: the Worker boots without it. See src/config.ts.
	TOKEN_ENCRYPTION_KEY?: string;
}
