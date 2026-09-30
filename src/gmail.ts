// The only place gmux builds a Gmail API request. gmux never sends mail, and
// that is a code-level guarantee: the OAuth grant (gmail.compose) can send, so
// the Worker is what withholds it (AGENTS.md, GMX-4). Every future mail tool
// must call Gmail through gmailFetch and never call fetch on a Gmail URL
// itself; test/never-send.test.ts scans the source for anyone who does.

export const GMAIL_API = "https://gmail.googleapis.com";

const ALLOWED_HOSTS = new Set(["gmail.googleapis.com", "www.googleapis.com"]);

// users.messages.send and users.drafts.send, in the plain, upload and
// `:send` custom-method forms. Keep this the one spelling of the patterns.
const SEND_PATH = /(messages|drafts)[/:]send(\/|$)/;
// A batch body could carry a send that can't be seen from the path.
const BATCH_PATH = /^\/batch(\/|$)/;

/** The pathname as Gmail would resolve it: decoded until stable, lower-cased, dot segments and repeated slashes removed. */
function normalisedPath(url: URL): string {
	let path = url.pathname;
	for (let i = 0; i < 10; i++) {
		const decoded = decodeURIComponent(path);
		if (decoded === path) break;
		path = decoded;
	}
	const segments: string[] = [];
	for (const segment of path.toLowerCase().split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

/** True if the URL is a send or batch endpoint. A path that can't be decoded counts as one: refuse what can't be read. */
export function looksLikeSend(url: string | URL): boolean {
	try {
		const path = normalisedPath(new URL(url));
		return SEND_PATH.test(path) || BATCH_PATH.test(path);
	} catch {
		return true;
	}
}

/** Throws for any send or batch endpoint, and for any host but Google's API hosts. */
export function assertNotSend(url: string | URL): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("gmux never sends: refused a request to an unparseable URL");
	}
	if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase()) || looksLikeSend(parsed)) {
		throw new Error(`gmux never sends: refused request to ${parsed.hostname}${parsed.pathname}`);
	}
}

/** Calls the Gmail API with `accessToken`, after refusing the send endpoints. `path` is relative to the API origin. */
export async function gmailFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
	const url = new URL(path, GMAIL_API);
	assertNotSend(url);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${accessToken}`);
	return fetch(url, { ...init, headers });
}
