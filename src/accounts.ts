// The account registry: which Google accounts are connected, and what to call
// them. The only module that touches `account:<email>` keys in GMUX_KV. A
// record holds no secret; the refresh token lives in src/token-store.ts under
// `refresh:<email>`, and the lower-cased email is the account name everywhere
// (token store, error classes, dashboard).
//
// On the stop-list (AGENTS.md): MAIL_SCOPES, DRIVE_SCOPES and REQUIRED_SCOPES are
// the connect grant's scope list.

import type { Env } from "./env.js";
import { describeError, type ErrorCode, MisconfiguredError, ReauthRequiredError } from "./errors.js";
import { type GoogleClient, getAccessToken } from "./google.js";
import { deleteRefreshToken } from "./token-store.js";

/**
 * The mailbox grant's whole scope list, besides `openid email` (which only
 * says which account was connected). gmux requests gmail.compose for drafts;
 * the grant can also send, so the Worker withholds that (GMX-4).
 */
export const MAIL_SCOPES = [
	"https://www.googleapis.com/auth/gmail.readonly",
	"https://www.googleapis.com/auth/gmail.compose",
] as const;

/**
 * The Drive grant. drive.readonly covers Drive file listing, metadata and
 * content, and the Docs API's documents.get. Write scopes wait for a write ticket.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"] as const;

/** Every scope a fully connected account carries. Connect requires all of them. */
export const REQUIRED_SCOPES = [...MAIL_SCOPES, ...DRIVE_SCOPES] as const;

export const LABEL_MAX_LENGTH = 64;
const PREFIX = "account:";

export interface Account {
	/** Lower-cased. Also the account name passed to the token store and the error classes. */
	email: string;
	/** The Google account id, as the id_token reported it. */
	sub: string;
	label: string;
	connectedAt: string;
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function accountKey(email: string): string {
	return `${PREFIX}${normalizeEmail(email)}`;
}

function isAccount(value: unknown): value is Account {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return ["email", "sub", "label", "connectedAt"].every((field) => typeof record[field] === "string");
}

async function readAccount(kv: KVNamespace, key: string): Promise<Account | null> {
	let value: unknown;
	try {
		value = await kv.get(key, "json");
	} catch {
		throw new MisconfiguredError([key], "the stored record can't be read");
	}
	if (value === null) return null;
	if (!isAccount(value)) throw new MisconfiguredError([key], "the stored record is malformed");
	return value;
}

export function getAccount(kv: KVNamespace, email: string): Promise<Account | null> {
	return readAccount(kv, accountKey(email));
}

/** Every connected account, sorted by label. An unreadable record throws MisconfiguredError; it's never skipped. */
export async function listAccounts(kv: KVNamespace): Promise<Account[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, cursor });
		keys.push(...page.keys.map((key) => key.name));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	const records = await Promise.all(keys.map((key) => readAccount(kv, key)));
	return records
		.filter((record): record is Account => record !== null)
		.sort((a, b) => a.label.localeCompare(b.label) || a.email.localeCompare(b.email));
}

/** Creates or updates the account's record. A reconnect keeps the label it already had. */
export async function saveAccount(
	kv: KVNamespace,
	account: { email: string; sub: string; connectedAt: string },
): Promise<Account> {
	const email = normalizeEmail(account.email);
	const existing = await getAccount(kv, email);
	const saved: Account = {
		email,
		sub: account.sub,
		label: existing?.label ?? email,
		connectedAt: account.connectedAt,
	};
	await kv.put(accountKey(email), JSON.stringify(saved));
	return saved;
}

/** An empty label resets to the email. "invalid" is a label over the length limit. */
export async function renameAccount(
	kv: KVNamespace,
	email: string,
	label: string,
): Promise<"ok" | "not_found" | "invalid"> {
	const account = await getAccount(kv, email);
	if (!account) return "not_found";
	const trimmed = label.trim();
	if (trimmed.length > LABEL_MAX_LENGTH) return "invalid";
	await kv.put(accountKey(email), JSON.stringify({ ...account, label: trimmed || account.email }));
	return "ok";
}

/** Forgets the account and its stored token. Doesn't revoke anything at Google. */
export async function removeAccount(kv: KVNamespace, email: string): Promise<void> {
	// Token first: if this throws, the account stays listed and Remove can be retried.
	await deleteRefreshToken(kv, normalizeEmail(email));
	await kv.delete(accountKey(email));
}

export type AccountHealth = { state: "ok" } | { state: ErrorCode; sentence: string };

/**
 * Refreshes the account's grant and returns the access token, after checking
 * it carries every scope in `scopes`. A tool passes only its own service's
 * scopes, so a grant missing Drive doesn't break mail. Throws one of the
 * error classes when it doesn't work.
 */
export async function hasScopes(
	env: Env,
	client: GoogleClient,
	email: string,
	scopes: readonly string[],
): Promise<string> {
	const { accessToken, scopes: granted } = await getAccessToken(env, client, email);
	if (!scopes.every((scope) => granted.includes(scope))) throw new ReauthRequiredError(email, "missing_scopes");
	return accessToken;
}

/** Refreshes the account's grant and checks it still carries every required scope. The access token is discarded. */
export async function checkAccount(env: Env, client: GoogleClient, email: string): Promise<void> {
	await hasScopes(env, client, email, REQUIRED_SCOPES);
}

/**
 * Whether the account's grant still works right now, by refreshing it. A
 * grant that no longer carries every required scope counts as needing a
 * reconnect. Anything that isn't one of the three error classes is a bug and
 * is rethrown.
 */
export async function accountHealth(env: Env, client: GoogleClient, email: string): Promise<AccountHealth> {
	try {
		await checkAccount(env, client, email);
		return { state: "ok" };
	} catch (error) {
		const described = describeError(error);
		if (!described) throw error;
		return { state: described.code, sentence: described.sentence };
	}
}
