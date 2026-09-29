import type { SetupState } from "../config.js";
import { Layout } from "./layout.js";

function Step(props: { done: boolean; title: string; children?: unknown }) {
	return (
		<li class={props.done ? "step done" : "step"}>
			<span class="status">{props.done ? "Done" : "To do"}</span>
			<div>
				<h2>{props.title}</h2>
				{props.children}
			</div>
		</li>
	);
}

/**
 * What a fresh, unconfigured deploy serves instead of an error. The setup
 * wizard proper (GMX-3) replaces the Google client step's body.
 */
export function SetupPage(props: { origin: string; state: SetupState }) {
	const { origin, state } = props;
	return (
		<Layout title="Setup">
			<h1>Finish setting up gmux</h1>
			<p class="lede">
				Your gmux is live at <code>{origin}</code>. A couple of things are left before it can reach your Google
				accounts.
			</p>
			<ol class="steps">
				<Step done={state.encryptionKey} title="Encryption key">
					{state.encryptionKey ? (
						<p>Set. Stored Google tokens are encrypted with it.</p>
					) : (
						<>
							<p>
								Missing or invalid. gmux won't store any Google tokens until it's set. From a clone of this repo, run:
							</p>
							<pre>
								<code>openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY</code>
							</pre>
						</>
					)}
				</Step>
				<Step done={state.googleClient} title="Google OAuth client">
					<p>{state.googleClient ? "Configured." : "Not configured yet. Guided setup for this step is coming."}</p>
				</Step>
			</ol>
		</Layout>
	);
}

/** Placeholder for the everyday dashboard (GMX-9), shown once setup is complete. */
export function DashboardPage() {
	return (
		<Layout title="Dashboard">
			<h1>gmux</h1>
			<p class="lede">Setup is complete. Connected accounts will be listed here.</p>
		</Layout>
	);
}

/** /authorize, until Google sign-in (GMX-2) exists. Never completes an authorization. */
export function SignInUnavailablePage() {
	return (
		<Layout title="Sign-in unavailable">
			<h1>Sign-in isn't available yet</h1>
			<p class="lede">
				This gmux can't grant access to an MCP client yet, so nothing can connect to it. Nothing was shared.
			</p>
		</Layout>
	);
}

export function NotFoundPage() {
	return (
		<Layout title="Not found">
			<h1>Not found</h1>
			<p class="lede">
				There's nothing at this address. <a href="/">Go to gmux</a>.
			</p>
		</Layout>
	);
}
