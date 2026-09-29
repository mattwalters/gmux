// Everything that isn't the protected /mcp route: the admin UI and the
// application-owned half of the OAuth flow. Server-rendered with Hono's JSX
// and one hand-written stylesheet - no client framework, no build step.
// Runs as src/gate.ts's defaultHandler, after the OAuth library has taken
// its own routes (/token, /register, /.well-known/*).

import { Hono } from "hono";
import { isConfigured, readSetupState } from "./config.js";
import type { Env } from "./env.js";
import styles from "./style.css";
import { DashboardPage, NotFoundPage, SetupPage, SignInUnavailablePage } from "./views/setup.js";

const app = new Hono<{ Bindings: Env }>();

app.use(async (c, next) => {
	await next();
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	c.header("X-Frame-Options", "DENY");
	c.header(
		"Content-Security-Policy",
		"default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'",
	);
});

app.get("/", async (c) => {
	const state = await readSetupState(c.env);
	if (isConfigured(state)) return c.html(<DashboardPage />);
	return c.html(<SetupPage origin={new URL(c.req.url).origin} state={state} />);
});

app.get("/style.css", (c) => {
	c.header("Content-Type", "text/css; charset=utf-8");
	c.header("Cache-Control", "public, max-age=300");
	return c.body(styles);
});

// Fail closed until GMX-2 adds Google sign-in: never call
// completeAuthorization(), so no connector token can ever be issued.
app.on(["GET", "POST"], "/authorize", (c) => c.html(<SignInUnavailablePage />, 503));

app.notFound((c) => c.html(<NotFoundPage />, 404));

export default app;
