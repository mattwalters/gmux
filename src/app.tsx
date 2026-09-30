// Everything that isn't the protected /mcp route: the admin UI and the
// application-owned half of the OAuth flow. Server-rendered with Hono's JSX
// and one hand-written stylesheet - no client framework, no build step.
// Runs as src/gate.ts's defaultHandler, after the OAuth library has taken
// its own routes (/token, /register, /.well-known/*).
//
// Sign-in is Google's, and trust-on-first-use: the first account through
// /signin/callback becomes the owner (src/owner.ts) and nobody else gets a
// session. Connector tokens are only issued from POST /authorize, to the
// owner's session, after a consent step. On the stop-list (AGENTS.md).

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { accountHealth, getAccount, listAccounts, normalizeEmail, removeAccount, renameAccount } from "./accounts.js";
import {
	isClientId,
	isConfigured,
	parseGoogleClientForm,
	readGoogleClient,
	readSetupState,
	writeGoogleClient,
} from "./config.js";
import { finishConnect, startConnect, takeConnect } from "./connect.js";
import type { Env } from "./env.js";
import { describeError } from "./errors.js";
import { MCP_SCOPE } from "./gate.js";
import type { GoogleClient } from "./google.js";
import { claimOwnerIfUnclaimed, type Owner, readOwner } from "./owner.js";
import {
	createSession,
	destroySession,
	randomToken,
	readSession,
	SESSION_COOKIE,
	SESSION_TTL_SECONDS,
	type Session,
} from "./session.js";
import { googleRedirectUri, startSignIn, takePending, verifyCallback } from "./signin.js";
import styles from "./style.css";
import { COPY_SCRIPT } from "./views/copy-script.js";
import { type AccountRow, DashboardPage } from "./views/dashboard.js";
import { NotFoundPage, SetupPage, SetupRefusedPage } from "./views/setup.js";
import {
	BadConnectorRequestPage,
	ClaimedPage,
	ClaimPage,
	ConnectFailedPage,
	ConsentPage,
	ErrorPage,
	FinishSetupPage,
	SignInCancelledPage,
	SignInFailedPage,
	SignInPage,
} from "./views/signin.js";

type AppContext = Context<{ Bindings: Env; Variables: { owner: Owner | null } }>;

const app = new Hono<{ Bindings: Env; Variables: { owner: Owner | null } }>();

const CSP_HEADER = "Content-Security-Policy";
const CONSENT_TTL_SECONDS = 600;

function csp(formAction: string): string {
	return `default-src 'none'; script-src 'self'; style-src 'self'; form-action ${formAction}; frame-ancestors 'none'`;
}

app.use(async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Frame-Options", "DENY");
	// A page may set its own CSP (the consent page widens form-action).
	if (!c.res.headers.has(CSP_HEADER)) c.header(CSP_HEADER, csp("'self'"));
});

// Loads the owner for the layout and the session check. Throws only for an
// unreadable record, which onError renders.
app.use(async (c, next) => {
	c.set("owner", await readOwner(c.env.GMUX_KV));
	await next();
});

app.onError((error, c) => {
	const described = describeError(error);
	if (!described) throw error;
	return c.html(<ErrorPage owner={c.get("owner")} described={described} />, 503);
});

function currentSession(c: AppContext): Promise<Session | null> {
	return readSession(c.env.GMUX_KV, getCookie(c, SESSION_COOKIE), c.get("owner"));
}

/** The Google client, or null when setup isn't finished. A malformed client throws MisconfiguredError. */
async function googleClientIfConfigured(c: AppContext): Promise<GoogleClient | null> {
	if (!isConfigured(await readSetupState(c.env))) return null;
	return readGoogleClient(c.env);
}

/** The form-action source for a connector's redirect URI: its origin, or its scheme for a custom one. */
function redirectSource(redirectUri: string): string {
	const url = new URL(redirectUri);
	const source = url.protocol === "http:" || url.protocol === "https:" ? url.origin : url.protocol;
	return /^[a-z][a-z0-9+.-]*:(\/\/[A-Za-z0-9.\-:[\]]+)?$/i.test(source) ? source : "'self'";
}

async function renderConsent(c: AppContext, session: Session, oauthReqInfo: AuthRequest) {
	const client = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
	if (!client) return c.html(<BadConnectorRequestPage owner={c.get("owner")} />, 400);
	const consentId = randomToken();
	await c.env.GMUX_KV.put(`consent:${consentId}`, JSON.stringify({ oauthReqInfo, sub: session.sub }), {
		expirationTtl: CONSENT_TTL_SECONDS,
	});
	c.header(CSP_HEADER, csp(`'self' ${redirectSource(oauthReqInfo.redirectUri)}`));
	return c.html(
		<ConsentPage
			owner={c.get("owner")}
			clientName={client.clientName || client.clientId}
			redirectHost={new URL(oauthReqInfo.redirectUri).host}
			consentId={consentId}
			csrf={session.csrf}
		/>,
	);
}

async function renderSetup(c: AppContext, form: { error?: string; clientId?: string } = {}, status: 200 | 400 = 200) {
	const origin = new URL(c.req.url).origin;
	const state = await readSetupState(c.env);
	return c.html(
		<SetupPage
			owner={c.get("owner")}
			origin={origin}
			redirectUri={googleRedirectUri(origin)}
			state={state}
			error={form.error}
			clientId={form.clientId ?? state.googleClientId}
		/>,
		status,
	);
}

app.get("/", async (c) => {
	const owner = c.get("owner");
	const state = await readSetupState(c.env);
	if (!isConfigured(state)) return renderSetup(c);
	if (!owner) return c.html(<ClaimPage owner={owner} />);
	const session = await currentSession(c);
	if (!session) return c.html(<SignInPage owner={owner} />);
	const client = await readGoogleClient(c.env);

	const rows: AccountRow[] = await Promise.all(
		(await listAccounts(c.env.GMUX_KV)).map(async (account) => ({
			account,
			health: await accountHealth(c.env, client, account.email),
		})),
	);
	// A misconfigured deployment fails every row the same way: say it once.
	const misconfigured = rows.find((row) => row.health.state === "misconfigured")?.health;
	const query = new URL(c.req.url).searchParams;
	const connected = query.get("connected");

	// "Connect account" posts here and is redirected on to Google; form-action
	// covers that redirect too.
	c.header(CSP_HEADER, csp("'self' https://accounts.google.com"));
	return c.html(
		<DashboardPage
			owner={owner}
			signOutCsrf={session.csrf}
			origin={new URL(c.req.url).origin}
			rows={rows}
			banner={misconfigured && misconfigured.state !== "ok" ? misconfigured.sentence : undefined}
			connected={connected ? { email: connected, expectedEmail: query.get("expected") ?? undefined } : undefined}
		/>,
	);
});

// The setup wizard, until somebody claims the instance. Editing the client
// after that belongs to the dashboard.
app.get("/setup", async (c) => (c.get("owner") ? c.redirect("/") : await renderSetup(c)));

// Unauthenticated by necessity: nobody can sign in before a client exists. So,
// like the owner claim, it's trust-on-first-use: closed once an owner exists,
// and only accepted from this site's own pages. On the stop-list (AGENTS.md).
app.post("/setup/google-client", async (c) => {
	const owner = c.get("owner");
	if (owner) return c.html(<SetupRefusedPage owner={owner}>This gmux is already claimed.</SetupRefusedPage>, 403);
	// Our pages send Referrer-Policy: no-referrer, so browsers put "Origin: null"
	// on their own form posts. "null" says nothing about the source: decide on
	// Sec-Fetch-Site instead, as for a missing Origin.
	const origin = c.req.header("Origin");
	const sameSite =
		origin && origin !== "null"
			? origin === new URL(c.req.url).origin
			: c.req.header("Sec-Fetch-Site") === "same-origin";
	if (!sameSite) {
		return c.html(<SetupRefusedPage owner={owner}>That request didn't come from this page.</SetupRefusedPage>, 403);
	}

	// A body that isn't a form reads as an empty one.
	const form = await c.req.formData().catch(() => new FormData());
	const submitted = form.get("client_id");
	const parsed = parseGoogleClientForm(submitted, form.get("client_secret"));
	if ("error" in parsed) {
		// Echo only a value shaped like a client ID; anything else may be a pasted secret.
		const echo = typeof submitted === "string" && isClientId(submitted.trim()) ? submitted.trim() : "";
		return renderSetup(c, { error: parsed.error, clientId: echo }, 400);
	}
	await writeGoogleClient(c.env, parsed);
	return c.redirect("/", 303);
});

app.get("/copy.js", (c) => {
	c.header("Content-Type", "text/javascript; charset=utf-8");
	c.header("Cache-Control", "public, max-age=300");
	return c.body(COPY_SCRIPT);
});

app.get("/style.css", (c) => {
	c.header("Content-Type", "text/css; charset=utf-8");
	c.header("Cache-Control", "public, max-age=300");
	return c.body(styles);
});

app.get("/signin", async (c) => {
	const client = await googleClientIfConfigured(c);
	if (!client) return c.html(<FinishSetupPage owner={c.get("owner")} />, 503);
	return c.redirect(await startSignIn(c.env.GMUX_KV, new URL(c.req.url).origin, client, "admin"));
});

app.get("/signin/callback", async (c) => {
	const owner = c.get("owner");
	const client = await googleClientIfConfigured(c);
	if (!client) return c.html(<FinishSetupPage owner={owner} />, 503);

	const params = new URL(c.req.url).searchParams;

	// A mailbox connect has its own pending state. Anything else is a sign-in.
	const connect = await takeConnect(c.env.GMUX_KV, params.get("state"));
	if (connect) {
		const session = await currentSession(c);
		if (!session || session.sub !== connect.sub) return c.html(<SignInFailedPage owner={owner} />, 403);
		if (params.get("error") === "access_denied") {
			return c.html(
				<ConnectFailedPage owner={owner}>You cancelled at Google. Nothing was connected.</ConnectFailedPage>,
			);
		}
		const code = params.get("code");
		if (params.has("error") || !code) {
			return c.html(
				<ConnectFailedPage owner={owner}>Google didn't complete the connection. Try again.</ConnectFailedPage>,
				400,
			);
		}
		const result = await finishConnect(c.env, new URL(c.req.url).origin, client, connect, code);
		if (result.kind === "connected") {
			const query = new URLSearchParams({ connected: result.email });
			if (result.expectedEmail) query.set("expected", result.expectedEmail);
			return c.redirect(`/?${query}`);
		}
		if (result.kind === "missing_scopes") {
			return c.html(
				<ConnectFailedPage owner={owner}>
					Google's consent screen has a checkbox for each permission, and one gmux needs wasn't ticked, so nothing was
					connected. Try again and leave every box ticked.
				</ConnectFailedPage>,
				400,
			);
		}
		return c.html(
			<ConnectFailedPage owner={owner}>
				That connection couldn't be completed, so nothing was connected. Try again.
			</ConnectFailedPage>,
			400,
		);
	}

	const pending = await takePending(c.env.GMUX_KV, params.get("state"));
	if (!pending) return c.html(<SignInFailedPage owner={owner} />, 400);
	if (params.get("error") === "access_denied") return c.html(<SignInCancelledPage owner={owner} />);
	const code = params.get("code");
	if (params.has("error") || !code) return c.html(<SignInFailedPage owner={owner} />, 400);

	const identity = await verifyCallback(new URL(c.req.url).origin, client, pending, code);
	if (!identity) return c.html(<SignInFailedPage owner={owner} />, 400);

	const claimed = await claimOwnerIfUnclaimed(c.env.GMUX_KV, identity);
	if (claimed.sub !== identity.sub) return c.html(<ClaimedPage owner={claimed} />, 403);
	c.set("owner", claimed);

	const { id, session } = await createSession(c.env.GMUX_KV, identity);
	setCookie(c, SESSION_COOKIE, id, {
		secure: true,
		httpOnly: true,
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_TTL_SECONDS,
	});
	if (pending.purpose === "mcp" && pending.oauthReqInfo) return renderConsent(c, session, pending.oauthReqInfo);
	return c.redirect("/");
});

app.get("/authorize", async (c) => {
	const client = await googleClientIfConfigured(c);
	if (!client) return c.html(<FinishSetupPage owner={c.get("owner")} />, 503);

	let oauthReqInfo: AuthRequest;
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	} catch {
		// The library throws for a request it won't honour: unknown client,
		// unregistered redirect URI, unsupported response type.
		return c.html(<BadConnectorRequestPage owner={c.get("owner")} />, 400);
	}
	if (!(await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId))) {
		return c.html(<BadConnectorRequestPage owner={c.get("owner")} />, 400);
	}

	const session = await currentSession(c);
	if (session) return renderConsent(c, session, oauthReqInfo);
	return c.redirect(await startSignIn(c.env.GMUX_KV, new URL(c.req.url).origin, client, "mcp", oauthReqInfo));
});

// The only place a connector token is issued: the owner's session, its CSRF
// token and a one-time consent record must all line up.
app.post("/authorize", async (c) => {
	const owner = c.get("owner");
	const session = await currentSession(c);
	const form = await c.req.formData();
	const csrf = form.get("csrf");
	const consentId = form.get("consent");
	if (!session || typeof csrf !== "string" || csrf !== session.csrf || typeof consentId !== "string" || !consentId) {
		return c.html(<SignInFailedPage owner={owner} />, 403);
	}
	const record = await c.env.GMUX_KV.get<{ oauthReqInfo: AuthRequest; sub: string }>(`consent:${consentId}`, "json");
	if (!record || record.sub !== session.sub) return c.html(<SignInFailedPage owner={owner} />, 403);
	await c.env.GMUX_KV.delete(`consent:${consentId}`);

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: record.oauthReqInfo,
		userId: session.sub,
		scope: [MCP_SCOPE],
		metadata: { email: session.email },
		props: { sub: session.sub, email: session.email },
	});
	return c.redirect(redirectTo);
});

/** The owner's session and the form it posted, or null unless both are valid and the CSRF token matches. */
async function ownerForm(c: AppContext): Promise<{ session: Session; form: FormData } | null> {
	const session = await currentSession(c);
	const form = await c.req.formData().catch(() => new FormData());
	const csrf = form.get("csrf");
	if (!session || typeof csrf !== "string" || csrf !== session.csrf) return null;
	return { session, form };
}

function formEmail(form: FormData): string {
	const email = form.get("email");
	return typeof email === "string" ? normalizeEmail(email) : "";
}

app.post("/accounts/connect", async (c) => {
	const posted = await ownerForm(c);
	if (!posted) return c.html(<SignInFailedPage owner={c.get("owner")} />, 403);
	const client = await googleClientIfConfigured(c);
	if (!client) return c.html(<FinishSetupPage owner={c.get("owner")} />, 503);
	// Only an account that's on the list can be the one being reconnected.
	const email = formEmail(posted.form);
	const reconnect = email && (await getAccount(c.env.GMUX_KV, email)) ? email : undefined;
	return c.redirect(
		await startConnect(c.env.GMUX_KV, new URL(c.req.url).origin, client, posted.session, reconnect),
		303,
	);
});

app.post("/accounts/rename", async (c) => {
	const posted = await ownerForm(c);
	if (!posted) return c.html(<SignInFailedPage owner={c.get("owner")} />, 403);
	const label = posted.form.get("label");
	const result = await renameAccount(c.env.GMUX_KV, formEmail(posted.form), typeof label === "string" ? label : "");
	if (result === "not_found") return c.html(<NotFoundPage owner={c.get("owner")} />, 404);
	if (result === "invalid") {
		return c.html(
			<SetupRefusedPage owner={c.get("owner")}>A label can be 64 characters at most.</SetupRefusedPage>,
			400,
		);
	}
	return c.redirect("/", 303);
});

app.post("/accounts/remove", async (c) => {
	const posted = await ownerForm(c);
	if (!posted) return c.html(<SignInFailedPage owner={c.get("owner")} />, 403);
	const email = formEmail(posted.form);
	if (email) await removeAccount(c.env.GMUX_KV, email);
	return c.redirect("/", 303);
});

app.post("/signout", async (c) => {
	const session = await currentSession(c);
	const csrf = (await c.req.formData()).get("csrf");
	if (session && csrf === session.csrf) {
		await destroySession(c.env.GMUX_KV, getCookie(c, SESSION_COOKIE) as string);
		deleteCookie(c, SESSION_COOKIE, { secure: true, path: "/" });
	}
	return c.redirect("/");
});

app.notFound((c) => c.html(<NotFoundPage owner={c.get("owner")} />, 404));

export default app;
