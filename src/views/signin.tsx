import type { DescribedError } from "../errors.js";
import { Layout, type OwnerView } from "./layout.js";

/** Before anyone has claimed this gmux. A link, not a form: signing in starts at Google. */
export function ClaimPage(props: { owner: OwnerView }) {
	return (
		<Layout title="Claim" owner={props.owner}>
			<h1>Claim this gmux</h1>
			<p class="lede">
				Nobody owns this gmux yet. The first Google account to sign in becomes its owner, and only the owner can sign in
				after that. Changing the owner later means deleting <code>config:owner</code> in the Cloudflare dashboard.
			</p>
			<p>
				<a class="button" href="/signin">
					Sign in with Google to claim this gmux
				</a>
			</p>
			<p class="note">Google will only be asked for your email address.</p>
			<p class="note">
				Entered the wrong Google client? <a href="/setup">Change it</a>.
			</p>
		</Layout>
	);
}

export function SignInPage(props: { owner: OwnerView }) {
	return (
		<Layout title="Sign in" owner={props.owner}>
			<h1>Sign in</h1>
			<p class="lede">Only the owner can use this gmux.</p>
			<p>
				<a class="button" href="/signin">
					Sign in with Google
				</a>
			</p>
			<p class="note">Google will only be asked for your email address.</p>
		</Layout>
	);
}

/** Someone other than the owner signed in. They get the owner's address, not a blank refusal. */
export function ClaimedPage(props: { owner: { email: string } }) {
	return (
		<Layout title="Already claimed" owner={props.owner}>
			<h1>Already claimed</h1>
			<p class="lede">
				This gmux is already claimed by <strong>{props.owner.email}</strong>. You're not signed in, and nothing was
				shared.
			</p>
		</Layout>
	);
}

function Notice(props: { owner: OwnerView; title: string; children: string }) {
	return (
		<Layout title={props.title} owner={props.owner}>
			<h1>{props.title}</h1>
			<p class="lede">{props.children}</p>
			<p>
				<a href="/">Back to gmux</a>
			</p>
		</Layout>
	);
}

export function SignInCancelledPage(props: { owner: OwnerView }) {
	return (
		<Notice owner={props.owner} title="Sign-in cancelled">
			You cancelled the Google sign-in. Nothing was changed.
		</Notice>
	);
}

/** A bad, expired or reused sign-in. Never says which check failed. */
export function SignInFailedPage(props: { owner: OwnerView }) {
	return (
		<Notice owner={props.owner} title="Sign-in failed">
			That sign-in couldn't be completed. Start again from the gmux home page.
		</Notice>
	);
}

/** /authorize was called with something the OAuth library refused. */
export function BadConnectorRequestPage(props: { owner: OwnerView }) {
	return (
		<Notice owner={props.owner} title="Can't connect">
			That connection request isn't valid, so nothing was shared. Add gmux to the client again.
		</Notice>
	);
}

/** /signin or /authorize before setup is complete. */
export function FinishSetupPage(props: { owner: OwnerView }) {
	return (
		<Notice owner={props.owner} title="Finish setup first">
			Sign-in isn't available until gmux has an encryption key and a Google OAuth client. The home page shows what's
			left.
		</Notice>
	);
}

/** One of the three error classes, described the way src/errors.ts describes it. */
export function ErrorPage(props: { owner: OwnerView; described: DescribedError }) {
	return (
		<Layout title="Something's wrong" owner={props.owner}>
			<h1>Something's wrong</h1>
			<p class="lede">{props.described.sentence}</p>
			<p class="note">
				<code>{props.described.firstLine}</code>
			</p>
		</Layout>
	);
}

/** What an MCP client is asking for. Nothing is granted until the owner presses the button. */
export function ConsentPage(props: {
	owner: OwnerView;
	clientName: string;
	redirectHost: string;
	consentId: string;
	csrf: string;
}) {
	return (
		<Layout title="Connect a client" owner={props.owner} signOutCsrf={props.csrf}>
			<h1>Connect a client?</h1>
			<p class="lede">
				<strong>{props.clientName}</strong> wants to use this gmux. After you approve, it will send you back to{" "}
				<code>{props.redirectHost}</code>.
			</p>
			<p>Only approve a client you just added yourself.</p>
			<form method="post" action="/authorize" class="actions">
				<input type="hidden" name="consent" value={props.consentId} />
				<input type="hidden" name="csrf" value={props.csrf} />
				<button type="submit" class="button">
					Approve
				</button>
				<a href="/">Cancel</a>
			</form>
		</Layout>
	);
}
