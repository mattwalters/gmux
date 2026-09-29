import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
	// The OAuth library's own namespace: client registrations, grants and
	// connector tokens. Never read or written directly.
	OAUTH_KV: KVNamespace;
	// Everything of gmux's own: encrypted refresh tokens, and (GMX-3) the
	// Google OAuth client. Separate from OAUTH_KV so it can be inspected or
	// wiped without touching connector grants.
	GMUX_KV: KVNamespace;
	// Injected by OAuthProvider at request time; not a real binding.
	OAUTH_PROVIDER: OAuthHelpers;
	// Optional on purpose: the Worker boots without it. See src/config.ts.
	TOKEN_ENCRYPTION_KEY?: string;
}
