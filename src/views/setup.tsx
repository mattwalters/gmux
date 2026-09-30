import type { SetupState } from "../config.js";
import { CloudConsoleSteps } from "./cloud-console.js";
import { Layout, type OwnerView } from "./layout.js";

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

export function Copyable(props: { id: string; text: string }) {
	return (
		<p class="copyable">
			<code id={props.id}>{props.text}</code>
			<button type="button" data-copy={props.id}>
				Copy
			</button>
		</p>
	);
}

/**
 * What a fresh, unconfigured deploy serves instead of an error, and the
 * wizard for the Google client. `error` and `clientId` re-fill the form after
 * a rejected submit; the secret is never sent back.
 */
export function SetupPage(props: {
	owner: OwnerView;
	origin: string;
	redirectUri: string;
	state: SetupState;
	error?: string;
	clientId?: string;
}) {
	const { origin, redirectUri, state } = props;
	// Once claimed, the server refuses the client form, so the page only reports
	// what's missing and offers nothing to submit or claim.
	const owned = !!props.owner;
	return (
		<Layout title="Setup" owner={props.owner}>
			<h1>Finish setting up gmux</h1>
			<p class="lede">
				Your gmux is live at <code>{origin}</code>. That address comes from the Worker name you chose on Cloudflare's
				deploy screen. A couple of things are left before it can reach your Google accounts.
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
					<p>
						{state.googleClient ? (
							<>
								Configured
								{state.googleClientId && (
									<>
										: <code>{state.googleClientId}</code>
									</>
								)}
								.{owned ? "" : " Not yours? Re-enter it below."}
							</>
						) : (
							"Not configured yet. Google needs to know about this gmux first, and it takes about five minutes."
						)}
					</p>
					{owned ? (
						<p class="note">This gmux is already claimed, so the client can't be changed from this page.</p>
					) : (
						<>
							<h3>1. Copy this redirect URI</h3>
							<Copyable id="redirect-uri" text={redirectUri} />
							<h3>2. Create the client in Google Cloud Console</h3>
							<CloudConsoleSteps redirectUri={redirectUri} />
							<h3>3. Paste the client ID and secret</h3>
							{props.error && (
								<p class="error" role="alert">
									{props.error}
								</p>
							)}
							<form method="post" action="/setup/google-client" class="stack">
								<label>
									Client ID
									<input type="text" name="client_id" value={props.clientId ?? ""} required autocomplete="off" />
								</label>
								<label>
									Client secret
									<input type="password" name="client_secret" required autocomplete="off" />
								</label>
								<div class="actions">
									<button type="submit" class="button">
										Save
									</button>
								</div>
							</form>
							<p class="note">No redeploy needed. gmux saves this and carries on.</p>
							{state.googleClient && state.encryptionKey && (
								<p>
									Next: <a href="/">sign in with Google to claim this gmux</a>.
								</p>
							)}
						</>
					)}
				</Step>
			</ol>
		</Layout>
	);
}

/** A refused setup change: an owner exists, or the request didn't come from this page. */
export function SetupRefusedPage(props: { owner: OwnerView; children: string }) {
	return (
		<Layout title="Not allowed" owner={props.owner}>
			<h1>Not allowed</h1>
			<p class="lede">{props.children}</p>
			<p>
				<a href="/">Back to gmux</a>
			</p>
		</Layout>
	);
}

export function NotFoundPage(props: { owner: OwnerView }) {
	return (
		<Layout title="Not found" owner={props.owner}>
			<h1>Not found</h1>
			<p class="lede">
				There's nothing at this address. <a href="/">Go to gmux</a>.
			</p>
		</Layout>
	);
}
