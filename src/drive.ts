// The only place gmux builds a Drive or Docs API request. Read-only: driveFetch
// is GET only, pinned to the two API origins and their read paths, so this code
// can't be used to reach the other APIs that share www.googleapis.com.
//
// Two different APIs: Drive (find, list, metadata, export, raw content) and
// Docs (a document's structure, which src/docs-markdown.ts renders).

import { DRIVE_SCOPES, hasScopes } from "./accounts.js";
import { docsToMarkdown } from "./docs-markdown.js";
import type { Env } from "./env.js";
import { UpstreamUnavailableError } from "./errors.js";
import { apiError, fileRefusal, type GoogleClient } from "./google.js";

const DRIVE_ORIGIN = "https://www.googleapis.com";
const DOCS_ORIGIN = "https://docs.googleapis.com";
const DRIVE_PREFIX = "/drive/v3/";
const DOCS_PREFIX = "/v1/documents/";
const DRIVE_API = "Google Drive API";
const DOCS_API = "Google Docs API";

/** The most content characters a read returns. */
export const CONTENT_LIMIT = 200_000;
/** Above this size in bytes a raw file isn't downloaded at all. */
const DOWNLOAD_LIMIT = 10_000_000;

const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,owners(emailAddress),webViewLink,parents";

const DOC = "application/vnd.google-apps.document";
const SHEET = "application/vnd.google-apps.spreadsheet";
const SLIDES = "application/vnd.google-apps.presentation";

/** The path as Google would resolve it: decoded until stable, lower-cased, split into segments. */
function pathSegments(pathname: string): string[] {
	let path = pathname;
	for (let i = 0; i < 10; i++) {
		const decoded = decodeURIComponent(path);
		if (decoded === path) break;
		path = decoded;
	}
	return path.toLowerCase().split("/");
}

/** Throws unless `url` is a read path under Drive v3 or Docs v1 documents. */
function assertDriveUrl(url: URL): void {
	const drive = url.origin === DRIVE_ORIGIN && url.pathname.startsWith(DRIVE_PREFIX);
	const docs = url.origin === DOCS_ORIGIN && url.pathname.startsWith(DOCS_PREFIX);
	let refused = !drive && !docs;
	if (!refused) {
		try {
			const segments = pathSegments(url.pathname);
			refused = segments.some((segment) => ["..", ".", "batch", "upload", "gmail"].includes(segment));
		} catch {
			refused = true;
		}
	}
	if (refused) throw new Error(`gmux Drive code refused a request to ${url.hostname}${url.pathname}`);
}

/**
 * GETs a Drive v3 path (`/drive/v3/...`) or a Docs v1 path (`/v1/documents/...`)
 * with `accessToken`. Anything else (another method, another host, a batch,
 * upload or Gmail path) throws before fetch runs.
 */
export async function driveFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
	if ((init.method ?? "GET").toUpperCase() !== "GET") throw new Error("gmux Drive code is read-only: GET only");
	const base = path.startsWith(DOCS_PREFIX) ? DOCS_ORIGIN : DRIVE_ORIGIN;
	const url = new URL(path, base);
	assertDriveUrl(url);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	return fetch(url, { ...init, method: "GET", headers });
}

/** driveFetch, with a network throw or a non-2xx answer mapped to one of the three error classes. */
async function call(accessToken: string, account: string, path: string, api: string): Promise<Response> {
	let response: Response;
	try {
		response = await driveFetch(accessToken, path);
	} catch (error) {
		// driveFetch's own refusal is a bug in this file, not a reach failure.
		if (error instanceof Error && error.message.startsWith("gmux Drive code")) throw error;
		throw new UpstreamUnavailableError(account);
	}
	if (!response.ok) throw await apiError(account, response, api);
	return response;
}

/**
 * `call` for an export or download. A permanent per-file refusal from Google
 * (too large to export, download-restricted) is Google's answer about that
 * file, not an outage: it comes back as a FileContent saying so, with no retry
 * advice. Every other failure is mapped as `call` does.
 */
async function callContent(
	accessToken: string,
	account: string,
	path: string,
	what: string,
): Promise<Response | FileContent> {
	let response: Response;
	try {
		response = await driveFetch(accessToken, path);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("gmux Drive code")) throw error;
		throw new UpstreamUnavailableError(account);
	}
	if (response.ok) return response;
	const refusal = await fileRefusal(response);
	if (refusal) {
		return {
			text: null,
			note: `Content not read: Google refused to ${what} this file (${refusal}). Retrying won't help. Metadata only.`,
			truncated: false,
		};
	}
	throw await apiError(account, response, DRIVE_API);
}

async function json(response: Response, account: string): Promise<Record<string, unknown>> {
	try {
		const parsed: unknown = await response.json();
		if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
	} catch {
		// fall through: an unreadable body is Google not answering properly
	}
	throw new UpstreamUnavailableError(account, "outage", "unreadable response");
}

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	size?: string;
	owners: string[];
	webViewLink?: string;
}

function toFile(raw: unknown): DriveFile {
	const file = (raw ?? {}) as Record<string, unknown>;
	const owners = Array.isArray(file.owners) ? file.owners : [];
	const text = (value: unknown) => (typeof value === "string" ? value : undefined);
	return {
		id: text(file.id) ?? "",
		name: text(file.name) ?? "",
		mimeType: text(file.mimeType) ?? "",
		modifiedTime: text(file.modifiedTime),
		size: text(file.size),
		owners: owners.flatMap((owner) => {
			const email = text((owner as Record<string, unknown> | null)?.emailAddress);
			return email ? [email] : [];
		}),
		webViewLink: text(file.webViewLink),
	};
}

/** Escapes a value for a single-quoted string in a Drive `q` expression. */
export function escapeQueryValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

export interface SearchOptions {
	query?: string;
	mimeType?: string;
	pageSize: number;
}

export interface SearchResult {
	files: DriveFile[];
	/** Google returned a nextPageToken: more files match than were returned. */
	truncated: boolean;
	/** Google says it didn't search everything (`incompleteSearch`). */
	incompleteSearch: boolean;
}

/** Searches one account's Drive, shared drives included, in Google's own order. */
export async function searchFiles(
	env: Env,
	client: GoogleClient,
	account: string,
	options: SearchOptions,
): Promise<SearchResult> {
	const accessToken = await hasScopes(env, client, account, DRIVE_SCOPES);
	const clauses = ["trashed = false"];
	if (options.query) clauses.push(`fullText contains '${escapeQueryValue(options.query)}'`);
	if (options.mimeType) clauses.push(`mimeType = '${escapeQueryValue(options.mimeType)}'`);
	const params = new URLSearchParams({
		q: clauses.join(" and "),
		corpora: "allDrives",
		includeItemsFromAllDrives: "true",
		supportsAllDrives: "true",
		pageSize: String(options.pageSize),
		fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
	});
	if (!options.query) params.set("orderBy", "modifiedTime desc");
	const response = await call(accessToken, account, `${DRIVE_PREFIX}files?${params}`, DRIVE_API);
	const body = await json(response, account);
	return {
		files: (Array.isArray(body.files) ? body.files : []).map(toFile),
		truncated: typeof body.nextPageToken === "string" && body.nextPageToken.length > 0,
		incompleteSearch: body.incompleteSearch === true,
	};
}

export interface FileContent {
	/** The content as text, or null when none was read. */
	text: string | null;
	/** What was or wasn't read, and why, in a sentence. */
	note: string;
	truncated: boolean;
}

export type ReadResult = { notFound: true } | { notFound?: false; file: DriveFile; content: FileContent };

function isTextual(mimeType: string): boolean {
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml")
	);
}

function capped(text: string, note: string): FileContent {
	if (text.length <= CONTENT_LIMIT) return { text, note, truncated: false };
	return {
		text: text.slice(0, CONTENT_LIMIT),
		note: `${note} Truncated to the first ${CONTENT_LIMIT} characters.`,
		truncated: true,
	};
}

async function readContent(accessToken: string, account: string, file: DriveFile): Promise<FileContent> {
	const id = encodeURIComponent(file.id);
	const type = file.mimeType;

	if (type === DOC) {
		// Without this an editor gets suggestions inline, and the markdown would run
		// suggested deletions and insertions together with no marking.
		const response = await call(
			accessToken,
			account,
			`${DOCS_PREFIX}${id}?includeTabsContent=true&suggestionsViewMode=PREVIEW_WITHOUT_SUGGESTIONS`,
			DOCS_API,
		);
		const text = docsToMarkdown(await json(response, account));
		return capped(
			text,
			text === ""
				? "The document is empty."
				: "Google Doc, rendered as markdown from the Docs API, without pending suggestions.",
		);
	}
	const exportAs = type === SHEET ? "text/csv" : type === SLIDES ? "text/plain" : undefined;
	if (exportAs) {
		const response = await callContent(
			accessToken,
			account,
			`${DRIVE_PREFIX}files/${id}/export?mimeType=${encodeURIComponent(exportAs)}`,
			"export",
		);
		if (!(response instanceof Response)) return response;
		const note =
			type === SHEET
				? "Google Sheet, exported as CSV: only the first sheet, as Google exports it."
				: "Google Slides, exported as plain text.";
		return capped(await response.text(), note);
	}
	if (isTextual(type)) {
		if (file.size !== undefined && Number(file.size) > DOWNLOAD_LIMIT) {
			return {
				text: null,
				note: `Content not read: the file is ${file.size} bytes, over the ${DOWNLOAD_LIMIT} byte limit.`,
				truncated: false,
			};
		}
		const response = await callContent(
			accessToken,
			account,
			`${DRIVE_PREFIX}files/${id}?alt=media&supportsAllDrives=true`,
			"download",
		);
		if (!(response instanceof Response)) return response;
		return capped(await response.text(), "Text file, read as stored.");
	}
	return {
		text: null,
		note: `Content not read: gmux doesn't read ${type || "this kind of file"} content. Metadata only.`,
		truncated: false,
	};
}

/**
 * One file's metadata plus its content. A 404 on the metadata call is Google's
 * answer, not a reach failure, so it returns `{ notFound: true }`.
 */
export async function readFile(env: Env, client: GoogleClient, account: string, fileId: string): Promise<ReadResult> {
	const accessToken = await hasScopes(env, client, account, DRIVE_SCOPES);
	const path = `${DRIVE_PREFIX}files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=${encodeURIComponent(FILE_FIELDS)}`;
	let response: Response;
	try {
		response = await driveFetch(accessToken, path);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("gmux Drive code")) throw error;
		throw new UpstreamUnavailableError(account);
	}
	if (response.status === 404) return { notFound: true };
	if (!response.ok) throw await apiError(account, response, DRIVE_API);
	const file = toFile(await json(response, account));
	return { file, content: await readContent(accessToken, account, file) };
}
