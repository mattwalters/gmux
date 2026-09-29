// The front door. /mcp and everything under it is an OAuth-protected API
// route: @cloudflare/workers-oauth-provider rejects any request without a
// valid bearer token before src/mcp.ts ever sees it. Everything else - the
// admin UI, /authorize, discovery - goes to src/app.tsx.
//
// Fail closed until GMX-2: the only way to get a token is through
// /authorize, and /authorize never completes an authorization yet, so no
// token can exist and /mcp answers 401 to everyone.
//
// On the stop-list (AGENTS.md): a change here waits for a human to merge it.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import app from "./app.js";
import type { Env } from "./env.js";
import mcp from "./mcp.js";

export const MCP_PATH = "/mcp";
export const MCP_SCOPE = "mcp";

// Placeholder until GMX-2 decides what a grant carries (the signed-in
// owner's identity) and adds a per-request re-check against it here.
const apiHandler = {
	async fetch(request, env) {
		return mcp.fetch(request, env);
	},
} satisfies ExportedHandler<Env>;

function buildProvider(origin: string): OAuthProvider<Env> {
	return new OAuthProvider<Env>({
		apiRoute: `${origin}${MCP_PATH}`,
		apiHandler,
		defaultHandler: app,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/token",
		clientRegistrationEndpoint: "/register",
		scopesSupported: [MCP_SCOPE],
		resourceMetadata: { resource: `${origin}${MCP_PATH}`, resource_name: "gmux" },
	});
}

// The provider's canonical resource is an absolute URL fixed at
// construction, but a fresh deploy doesn't know its own hostname until the
// first request arrives - and nobody should have to type it in (GMX-3). So
// it's built from the request's origin, and cached per isolate. A Worker
// reached on two hostnames gets one provider per hostname; tokens are
// audience-bound, so a token minted on one is refused on the other.
let cached: { origin: string; provider: OAuthProvider<Env> } | undefined;

function providerFor(origin: string): OAuthProvider<Env> {
	if (cached?.origin !== origin) cached = { origin, provider: buildProvider(origin) };
	return cached.provider;
}

export default {
	async fetch(request, env, ctx) {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
