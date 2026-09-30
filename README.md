# gmux

A self-hosted MCP server that lets an AI assistant like Claude read across
several Google accounts at once. It runs as your own Cloudflare Worker, and
your Google tokens never pass through anyone else's servers.

> **Status: scaffolding.** The Worker deploys, boots and walks you through
> setup in the browser: your Google OAuth client, then claiming the
> instance. Its `/mcp` route is locked to your connector. Connecting
> accounts and the mail tools are still being built.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mattwalters/gmux)

Or, from a clone:

```sh
npm ci
npx wrangler login
npx wrangler deploy
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

The first deploy creates the Worker's two KV namespaces for you. Then open
the URL wrangler prints. You'll see the setup page, which shows what's left
to do.

### The one secret

| Secret | What it is | Set with |
| -- | -- | -- |
| `TOKEN_ENCRYPTION_KEY` | The AES-GCM key that encrypts stored Google refresh tokens. Standard base64 of 32 random bytes. | `openssl rand -base64 32 \| npx wrangler secret put TOKEN_ENCRYPTION_KEY` |

The key isn't shown or saved anywhere else. Rotating it means reconnecting
every account. Everything else (the Google OAuth client, the owner,
connected accounts) is configured in the browser after deploying, with no
redeploy.

## Routes

| Route | What it is |
| -- | -- |
| `GET /` | The admin UI. Shows the setup page until setup is complete, then the claim or sign-in page, then the dashboard. |
| `GET /setup` | The setup wizard, until someone claims the instance. Walks you through creating your Google OAuth client. Redirects to `/` once claimed. |
| `POST /setup/google-client` | Saves the Google OAuth client from the wizard. Refused once someone has claimed the instance, and from any other site. |
| `GET /style.css`, `GET /copy.js` | The stylesheet, and the small script behind the copy buttons. |
| `GET /signin`, `GET /signin/callback` | Google sign-in for the admin UI. The callback is the redirect URI to register with your Google OAuth client; the setup page shows it. |
| `POST /signout` | Ends the admin session. |
| `GET/POST /authorize` | Connector sign-in: Google sign-in if needed, then a consent page. Only the owner's approval issues a connector token. |
| `/token`, `/register`, `/.well-known/*` | The OAuth library's own endpoints. |
| `/mcp` and below | The MCP server. Needs a valid connector token; without one it returns `401`. |

The only MCP tool so far is `health_check`.

## Who owns your gmux

The first Google account to sign in becomes the owner. Nobody else can sign
in or connect a client after that. The owner's email is shown at the top of
every page, including to anyone who loads the Worker's public URL, so you can
see at a glance whether someone else got in. A second account that signs in
is told who owns it.

The claim can't be undone from the UI. To change the owner, delete the
`config:owner` key from the `GMUX_KV` namespace in the Cloudflare dashboard;
every session and connector token stops working at once.

Signing in to gmux asks Google for your email address only (`openid email`).
That is a separate grant from the ones that connect your mailboxes.

## Develop

```sh
npm ci
cp .dev.vars.example .dev.vars   # then fill in TOKEN_ENCRYPTION_KEY
npm run dev                      # http://localhost:8787
npm run check                    # typecheck, lint, tests - what CI runs
```

`npm run format` applies Biome's formatting and safe lint fixes.

See [`AGENTS.md`](AGENTS.md) for the stack, the review invariants and how
tickets flow through the factory pipeline.
