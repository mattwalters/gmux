// The front door. /mcp and everything under it is an OAuth-protected API
// route: @cloudflare/workers-oauth-provider rejects any request without a
// valid bearer token before src/mcp.ts ever sees it. Everything else - the
// admin UI, /authorize, discovery - goes to src/app.tsx.
//
// The only way to get a token is POST /authorize, which the owner's Google
// sign-in and a consent step guard. Each token carries the `sub` of the
// account that granted it, and every request re-checks that `sub` against the
// current owner, so clearing the owner in the Cloudflare dashboard revokes
// every token at once.
//
// On the stop-list (AGENTS.md): a change here waits for a human to merge it.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import app from "./app.js";
import type { Env } from "./env.js";
import mcp from "./mcp.js";
import { readOwner } from "./owner.js";

export const MCP_PATH = "/mcp";
export const MCP_SCOPE = "mcp";

// Reached only with a valid bearer token. No owner, no `sub` in the token's
// props, or a `sub` that isn't the owner's all get a 401 and never reach mcp.
const apiHandler = {
	async fetch(request, env, ctx) {
		const sub = (ctx.props as { sub?: unknown } | undefined)?.sub;
		const owner = await readOwner(env.GMUX_KV);
		if (!owner || typeof sub !== "string" || sub !== owner.sub) {
			const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
			return new Response("Unauthorized", {
				status: 401,
				headers: {
					"WWW-Authenticate": `Bearer error="invalid_token", error_description="This token's owner no longer owns this gmux", resource_metadata="${metadata}"`,
				},
			});
		}
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
