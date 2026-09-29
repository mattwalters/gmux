import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// The workerd bundled with the pinned @cloudflare/vitest-pool-workers
				// can be older than wrangler.jsonc's compatibility_date (kept current
				// for real deploys); override it for tests only.
				compatibilityDate: "2026-08-22",
				kvNamespaces: ["OAUTH_KV", "GMUX_KV"],
				bindings: {
					// Standard base64 of 32 fixed bytes (a stable fixture); not a real secret.
					TOKEN_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
				},
			},
		}),
	],
});
