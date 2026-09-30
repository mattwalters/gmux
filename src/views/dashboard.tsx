import type { Account, AccountHealth } from "../accounts.js";
import { LABEL_MAX_LENGTH } from "../accounts.js";
import { MCP_PATH } from "../gate.js";
import { Layout, type OwnerView } from "./layout.js";
import { Copyable } from "./setup.js";

export interface AccountRow {
	account: Account;
	health: AccountHealth;
}

/** What the connect redirect reports: the account that was connected, and the one the user meant to repair, if different. */
export interface ConnectedNotice {
	email: string;
	expectedEmail?: string;
}

const PILLS: Record<AccountHealth["state"], string> = {
	ok: "Connected",
	reauth_required: "Needs reconnecting",
	upstream_unavailable: "Google didn't answer",
	misconfigured: "Can't check",
};

function AccountItem(props: { row: AccountRow; csrf: string }) {
	const { account, health } = props.row;
	return (
		<li class="account" data-state={health.state}>
			<div class="identity">
				<strong>{account.label}</strong>
				{account.label !== account.email && <span class="email">{account.email}</span>}
			</div>
			<span class="pill">{PILLS[health.state]}</span>
			<div class="row-actions">
				{health.state === "reauth_required" && (
					<form method="post" action="/accounts/connect">
						<input type="hidden" name="csrf" value={props.csrf} />
						<input type="hidden" name="email" value={account.email} />
						<button type="submit" class="button small">
							Reconnect
						</button>
					</form>
				)}
				<form method="post" action="/accounts/remove">
					<input type="hidden" name="csrf" value={props.csrf} />
					<input type="hidden" name="email" value={account.email} />
					<button type="submit" class="link">
						Remove
					</button>
				</form>
			</div>
			{health.state !== "ok" && health.state !== "misconfigured" && <p class="sentence">{health.sentence}</p>}
			<details class="rename">
				<summary>Rename</summary>
				<form method="post" action="/accounts/rename" class="inline">
					<input type="hidden" name="csrf" value={props.csrf} />
					<input type="hidden" name="email" value={account.email} />
					<input
						type="text"
						name="label"
						value={account.label}
						maxlength={LABEL_MAX_LENGTH}
						placeholder={account.email}
						aria-label={`Label for ${account.email}`}
					/>
					<button type="submit" class="link">
						Save
					</button>
				</form>
			</details>
		</li>
	);
}

/** The owner's everyday page: connected accounts and their health, then how to connect Claude. */
export function DashboardPage(props: {
	owner: OwnerView;
	signOutCsrf: string;
	origin: string;
	rows: AccountRow[];
	connected?: ConnectedNotice;
	/** The sentence for a misconfigured deployment, shown once instead of on every row. */
	banner?: string;
}) {
	const mcpUrl = `${props.origin}${MCP_PATH}`;
	const csrf = props.signOutCsrf;
	return (
		<Layout title="Dashboard" owner={props.owner} signOutCsrf={csrf}>
			<h1>gmux</h1>
			{props.banner && (
				<p class="error" role="alert">
					{props.banner}
				</p>
			)}
			{props.connected && (
				<p class="notice" role="status">
					{props.connected.expectedEmail ? (
						<>
							Connected <strong>{props.connected.email}</strong>. You were reconnecting{" "}
							<strong>{props.connected.expectedEmail}</strong>, which wasn't touched and may still need reconnecting.
						</>
					) : (
						<>
							Connected <strong>{props.connected.email}</strong>.
						</>
					)}
				</p>
			)}
			<section>
				<h2>Accounts</h2>
				{props.rows.length === 0 ? (
					<p class="lede">No Google accounts are connected yet.</p>
				) : (
					<ul class="accounts">
						{props.rows.map((row) => (
							<AccountItem row={row} csrf={csrf} />
						))}
					</ul>
				)}
				<form method="post" action="/accounts/connect" class="actions">
					<input type="hidden" name="csrf" value={csrf} />
					<button type="submit" class="button">
						Connect account
					</button>
				</form>
				<p class="note">
					Google's consent screen will say gmux can send email. gmux never sends; it only reads and writes drafts.
				</p>
				<p class="note">
					Removing an account makes gmux forget its token. It doesn't revoke the grant at Google; do that at{" "}
					<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
				</p>
			</section>
			<section>
				<h2>Connect Claude</h2>
				<p>This is the connection string for this gmux:</p>
				<Copyable id="mcp-url" text={mcpUrl} />
				<ol>
					<li>In Claude, open Settings, then Connectors, then Add custom connector.</li>
					<li>Name it "gmux", paste the connection string, and add it.</li>
					<li>Sign in with the Google account that owns this gmux, then approve on gmux's consent page.</li>
				</ol>
				<p>In Claude Code, run this instead:</p>
				<pre>
					<code>{`claude mcp add --transport http gmux ${mcpUrl}`}</code>
				</pre>
			</section>
		</Layout>
	);
}
