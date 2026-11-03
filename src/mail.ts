// The mail read layer: search, one message, one thread. Read-only, and every
// request goes through gmailFetch (src/gmail.ts), which refuses the send and
// batch endpoints (GMX-4). This file builds no Gmail URL of its own: its paths
// are relative, and the origin lives in src/gmail.ts alone.
//
// Gmail's list endpoint returns only ids, so each search hit costs one more
// request for its headers. A Worker on the free plan may make 50 subrequests
// per invocation, and a "too many subrequests" throw would read as a Google
// outage, so a search takes an explicit budget (metadataBudget) and says
// honestly when it cut a result short.

import { hasScopes, MAIL_SCOPES } from "./accounts.js";
import type { Env } from "./env.js";
import { UpstreamUnavailableError } from "./errors.js";
import { gmailFetch } from "./gmail.js";
import { apiError, errorReasonsOf, type GoogleClient } from "./google.js";
import { MAX_PART_DEPTH, type MailHeader, type MailPart } from "./mail-text.js";

const GMAIL = "Gmail API";
const USER = "/gmail/v1/users/me";

/** Subrequests one search may spend across every account, under the free plan's 50 with margin. */
export const SEARCH_SUBREQUEST_BUDGET = 45;

/**
 * How many hits per account get their headers fetched. Each account spends two
 * subrequests before any hit (a token refresh and the list), so the rest of
 * the budget is shared out evenly. At least one, and never more than `limit`.
 */
export function metadataBudget(accountCount: number, limit: number): number {
	if (accountCount < 1) return limit;
	const share = Math.floor((SEARCH_SUBREQUEST_BUDGET - 2 * accountCount) / accountCount);
	return Math.max(1, Math.min(limit, share));
}

/** A GET to Gmail, with a network throw mapped to the upstream class. */
async function call(accessToken: string, account: string, path: string): Promise<Response> {
	try {
		return await gmailFetch(accessToken, path);
	} catch (error) {
		// gmailFetch's own refusal is a bug in this file, not a reach failure.
		if (error instanceof Error && error.message.startsWith("gmux never sends")) throw error;
		throw new UpstreamUnavailableError(account);
	}
}

/** A 400 with this reason is Gmail not understanding the id it was given, which is as good as not finding it. */
const INVALID_ARGUMENT = ["invalidArgument", "INVALID_ARGUMENT"];

/**
 * `call` for a by-id read. Gmail's own answer that the id isn't there (404, or
 * 400 invalidArgument for a malformed one) comes back as null, since it isn't
 * a reach failure. Every other failure is mapped by apiError.
 */
async function callById(accessToken: string, account: string, path: string): Promise<Response | null> {
	const response = await call(accessToken, account, path);
	if (response.ok) return response;
	if (response.status === 404) return null;
	if (response.status === 400) {
		const reasons = await errorReasonsOf(response);
		if (reasons.some((reason) => INVALID_ARGUMENT.includes(reason))) return null;
	}
	throw await apiError(account, response, GMAIL);
}

async function json(response: Response, account: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = await response.json();
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// fall through: an unreadable body is Google not answering properly
	}
	throw new UpstreamUnavailableError(account, "outage", "unreadable response");
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);
const record = (value: unknown) =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

function toHeaders(raw: unknown): MailHeader[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((item) => {
		const header = record(item);
		const name = text(header?.name);
		const value = text(header?.value);
		return name !== undefined && value !== undefined ? [{ name, value }] : [];
	});
}

function toPart(raw: unknown, depth = 0): MailPart | undefined {
	const part = record(raw);
	if (!part) return undefined;
	const body = record(part.body);
	return {
		mimeType: text(part.mimeType),
		filename: text(part.filename),
		headers: toHeaders(part.headers),
		body: body ? { size: typeof body.size === "number" ? body.size : undefined, data: text(body.data) } : undefined,
		parts:
			depth >= MAX_PART_DEPTH || !Array.isArray(part.parts)
				? []
				: part.parts.flatMap((child) => toPart(child, depth + 1) ?? []),
	};
}

export interface MailMessage {
	id: string;
	/** Empty when Google didn't say. */
	threadId: string;
	unread: boolean;
	snippet: string;
	/** Milliseconds since the epoch, when Google said. */
	internalDate?: number;
	payload?: MailPart;
}

/** Lenient, as Drive's toFile is: a field Google left out falls back, it doesn't throw. */
function toMessage(raw: unknown, requestedId: string): MailMessage {
	const message = record(raw) ?? {};
	const date = Number(text(message.internalDate));
	return {
		id: text(message.id) ?? requestedId,
		threadId: text(message.threadId) ?? "",
		unread: Array.isArray(message.labelIds) && message.labelIds.includes("UNREAD"),
		snippet: text(message.snippet) ?? "",
		internalDate: Number.isFinite(date) && date > 0 ? date : undefined,
		payload: toPart(message.payload),
	};
}

export interface SearchOptions {
	/** Gmail's own search syntax, passed through as given. */
	query: string;
	/** The most message ids to ask Gmail for. */
	limit: number;
	/** The most hits to fetch headers for; see metadataBudget. */
	metadataBudget: number;
}

export interface SearchHit {
	id: string;
	threadId: string;
	from: string;
	subject: string;
	snippet: string;
	internalDate?: number;
	unread: boolean;
}

export interface SearchResult {
	email: string;
	hits: SearchHit[];
	/** More messages match than the hits returned: Gmail had another page, or the subrequest budget cut it short. */
	truncated: boolean;
	/** Listed messages that were gone (404) by the time their headers were fetched. */
	vanished: number;
}

function toHit(message: MailMessage): SearchHit {
	const headers = message.payload?.headers ?? [];
	const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";
	return {
		id: message.id,
		threadId: message.threadId,
		from: header("from"),
		subject: header("subject"),
		snippet: message.snippet,
		internalDate: message.internalDate,
		unread: message.unread,
	};
}

/** Searches one account's mail, newest first as Gmail orders it. */
export async function searchMail(
	env: Env,
	client: GoogleClient,
	account: string,
	options: SearchOptions,
): Promise<SearchResult> {
	const accessToken = await hasScopes(env, client, account, MAIL_SCOPES);
	const list = new URLSearchParams({ maxResults: String(options.limit) });
	if (options.query) list.set("q", options.query);
	const listed = await call(accessToken, account, `${USER}/messages?${list}`);
	if (!listed.ok) throw await apiError(account, listed, GMAIL);
	const body = await json(listed, account);

	const ids = (Array.isArray(body.messages) ? body.messages : []).flatMap((item) => {
		const id = text(record(item)?.id);
		return id ? [id] : [];
	});
	const fetched = ids.slice(0, options.metadataBudget);
	const truncated =
		fetched.length < ids.length || (typeof body.nextPageToken === "string" && body.nextPageToken.length > 0);

	const metadata = new URLSearchParams({ format: "metadata" });
	for (const name of ["From", "To", "Subject"]) metadata.append("metadataHeaders", name);
	const messages = await Promise.all(
		fetched.map(async (id) => {
			const response = await callById(accessToken, account, `${USER}/messages/${encodeURIComponent(id)}?${metadata}`);
			return response ? toMessage(await json(response, account), id) : null;
		}),
	);
	const found = messages.filter((message): message is MailMessage => message !== null);
	return { email: account, hits: found.map(toHit), truncated, vanished: messages.length - found.length };
}

export type ReadMessageResult = { notFound: true } | { notFound?: false; message: MailMessage };

/** One message in full from one account. A 404 is Gmail's answer, not a reach failure. */
export async function readMessage(
	env: Env,
	client: GoogleClient,
	account: string,
	id: string,
): Promise<ReadMessageResult> {
	const accessToken = await hasScopes(env, client, account, MAIL_SCOPES);
	const response = await callById(accessToken, account, `${USER}/messages/${encodeURIComponent(id)}?format=full`);
	if (!response) return { notFound: true };
	return { message: toMessage(await json(response, account), id) };
}

export interface MailThread {
	id: string;
	/** Oldest first. */
	messages: MailMessage[];
}

export type ReadThreadResult = { notFound: true } | { notFound?: false; thread: MailThread };

/** One thread in full from one account, messages oldest first whatever order Gmail sent them in. */
export async function readThread(
	env: Env,
	client: GoogleClient,
	account: string,
	id: string,
): Promise<ReadThreadResult> {
	const accessToken = await hasScopes(env, client, account, MAIL_SCOPES);
	const response = await callById(accessToken, account, `${USER}/threads/${encodeURIComponent(id)}?format=full`);
	if (!response) return { notFound: true };
	const body = await json(response, account);
	const raw = Array.isArray(body.messages) ? body.messages : [];
	const messages = raw
		.map((item, index) => ({ message: toMessage(item, ""), index }))
		.sort((a, b) => (a.message.internalDate ?? 0) - (b.message.internalDate ?? 0) || a.index - b.index)
		.map(({ message }) => message);
	return { thread: { id: text(body.id) ?? id, messages } };
}
