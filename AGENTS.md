# Agent brief

gmux is a self-hosted remote MCP server on Cloudflare Workers that reaches
several Google accounts at once: mail, and later Drive and Calendar. Google's
own connectors each speak to one account. Fanning out across several is why
gmux exists.

**gmux is the hands, not the brain.** The brain is the MCP client (Claude
Code, to start with): it notices, summarises, decides and nudges. gmux
doesn't aggregate, interpret or alert on its own. A tool owes its caller
accurate reach, clean errors, and an honest account of what it did and
didn't cover. Don't build summarising or digesting into a tool; the client
does that better, with more context.

The repo is public, and strangers deploy it with the "Deploy to Cloudflare"
button. Real email addresses, account names and KV namespace ids are config,
and config stays out of version control.

## This file

AGENTS.md is the only agent brief here. CLAUDE.md is a one-line
`@AGENTS.md` import, so every toolchain reads the same text. Edit AGENTS.md
and leave the stub alone.

## Stack

TypeScript on Workers, **Hono** for routing, **Hono's built-in JSX** for
server-rendered HTML, and one hand-written stylesheet, `src/style.css`. No
React, no Vite, no Tailwind, no client-side build step. Wrangler bundles
`*.css` as a text module (see `wrangler.jsonc`'s `rules`), so the stylesheet
ships inside the Worker. There's no static-assets pipeline.

This is deliberate. A self-hosted tool fails when a stranger gives up, and
every build step is one more thing that can break on their deploy where we
never see it. If a page later needs real interactivity, add targeted
client-side JS to a server-rendered page. Don't add a framework.

Keep the stylesheet small, modern and readable in one sitting: native
nesting, custom properties for colour and spacing, the system font stack,
semantic selectors. It still has to look good. This is someone's daily tool
and a stranger's first impression.

## Layout

| Path | What it is |
| -- | -- |
| `src/gate.ts` | The front door. `/mcp` is an OAuth-protected route (`@cloudflare/workers-oauth-provider`); everything else goes to `src/app.tsx`. |
| `src/app.tsx`, `src/views/` | The admin UI and `/authorize`, as a Hono app. |
| `src/mcp.ts` | The MCP tools, behind the gate. |
| `src/signin.ts` | Google sign-in for the gate (`openid email` only): auth URL, PKCE, code exchange, id_token checks. |
| `src/owner.ts` | The trust-on-first-use owner record. The only module that touches `config:owner`. |
| `src/session.ts` | KV-backed admin sessions and their CSRF tokens. |
| `src/config.ts` | Fail-closed config: the encryption key, and what's been set up so far. |
| `src/errors.ts` | The three error classes and how each is described. |
| `src/token-store.ts` | Encrypted refresh tokens in `GMUX_KV`. |
| `src/google.ts` | Refresh-token exchange, and the mapping from Google's responses to the error classes. |

Token-store shape, error classes and (later) mail text cleaning are copied
from `servers/mail` in `mattwalters/ops`, not extracted into a shared
library. The two codebases are expected to drift: one is public and one is
private. Revisit only once the same change has been needed in both, twice.

## Deploying while developing

Iterate with `npx wrangler deploy` against one Worker. Don't use the deploy
button for routine testing: each click creates a new repo and a new Worker
with its own KV namespaces, and repeated clicks leave orphaned instances
behind. Save the button for deliberate tests of the stranger experience.

The Worker's name must match `name` in `wrangler.jsonc`, or builds fail. A
rename needs both.

`wrangler.jsonc` lists its KV bindings without ids, so the first deploy
provisions them. Never commit a namespace id that wrangler writes back into
the file. Every stranger's deploy would then point at a namespace they
don't own.

## Orchestrate

The `factory` pipeline (`orchestrate`, `implement-ticket`,
`adversarial-review`, `merge-queue`, `decision-queue`) reads this section
for its repo-specific configuration.

| Field        | Value                                   |
| ------------ | --------------------------------------- |
| Linear team  | `GMX`                                   |
| Base branch  | `main`                                  |
| Worktrees    | `$HOME/ops/worktrees/mattwalters/gmux/` |
| Write window | `none`                                  |

Per-ticket worktrees are detached, one per ticket, named for the ticket.
They live outside the repo so no `AGENTS.md`/`CLAUDE.md` above the checkout
loads into a ticket's run, under the unattended orchestrate job's write root
(`${OPS_WORKTREES:-$HOME/ops/worktrees}`), namespaced per repo so no other
adopting repo collides.

Expand `$HOME` to an absolute path before writing the worktrees value into a
prompt or using it in a file operation. A shell expands it on its own; a
subagent's Read/Edit/Write calls and a prompt placeholder don't.

**Getting the pipeline.** `factory` is installed once per machine at
user scope, not pinned by this repo. `.claude/settings.json` only
declares the `mattwalters` marketplace (github `mattwalters/skills`).
On a machine that does not have it installed yet, run:

```
claude plugin install factory@mattwalters --scope user
```

Do not install it at project scope or add it to `enabledPlugins` here.

**Check command.** An implementer or fixer runs this and passes it
before pushing:

```
npm ci && npm run check
```

`npm run check` runs typecheck (`tsc`), lint (`biome check`) and tests
(`vitest` in the Workers runtime). CI runs the same command on every PR.

### Review invariants

Treat a diff that breaks one of these as a major finding, not a nit.

- **Never send.** No code path calls Gmail's `users.messages.send` or
  `users.drafts.send`, or builds a request to either. The OAuth grant *can*
  send, because `gmail.compose` covers sending as well as drafts, so the
  Worker is the only thing withholding it (GMX-4). A test must fail loudly if
  either path ever appears in a request the server builds. UI and docs say
  gmux never sends. They never claim Google prevents it, and they warn that
  Google's consent screen will say "send email".
- **A partial read never looks complete.** A fan-out across accounts
  collects failures alongside results and names every account it couldn't
  reach **at the top** of the response, not in a footer (GMX-6). Each
  failure says which action to take, and a revoked account (reconnect or
  remove it) reads differently from a temporarily unavailable one (try
  again). No failure is ever reported as an empty result.
- **Every failure maps to one of the three error classes** in
  `src/errors.ts`: reauth-required, misconfigured, upstream-unavailable.
  Nothing swallows an error into a default value. An unrecognised error is
  a bug and is rethrown, not given a made-up message.
- **Fail closed.** `/mcp` and everything under it answers only to a valid
  connector token. A missing config value refuses access; it never falls
  back to open. No page, log line or tool result ever contains a refresh
  token, an access token, a client secret or `TOKEN_ENCRYPTION_KEY`.
- **Tokens encrypted at rest.** Refresh tokens live only as AES-GCM
  ciphertext bound to their account. `src/token-store.ts` is the only
  module that touches `refresh:*` keys.
- **Boots unconfigured.** With no Google client and no secrets, the Worker
  starts and serves the setup page rather than erroring. A change that
  makes any route throw on missing config is a finding.
- **Hands, not brain.** Tools return what Google returned, shaped for
  reading. They don't summarise, rank or decide.
- **No build step, no client framework.** See "Stack". A new runtime
  dependency needs a reason in the PR.
- **Minimum scopes.** Request the fewest Google scopes that do the job.
  Minimum access is still the rule, even though it isn't what enforces
  never-send.

### Stop-list

A change touching any of these waits for a human to merge it, whatever mode
the run is in.

- **The OAuth scope list**: any change to which Google scopes gmux
  requests, wherever they're declared.
- **The token store and its encryption**: `src/token-store.ts`,
  `readEncryptionKey()` in `src/config.ts`, and anything that reads, writes,
  derives or rotates `TOKEN_ENCRYPTION_KEY`.
- **The owner-claim logic**: who gets to claim an instance, how the claim
  is stored, and any path that changes or clears it (GMX-2).
- **The gate**: `src/gate.ts`, `/authorize`, and anything that decides
  whether a request reaches `/mcp`.
- **This `## Orchestrate` section**: the review invariants and this
  stop-list itself.
