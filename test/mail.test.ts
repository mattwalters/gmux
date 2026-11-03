import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_SCOPES, REQUIRED_SCOPES } from "../src/accounts.js";
import { MisconfiguredError, ReauthRequiredError, UpstreamUnavailableError } from "../src/errors.js";
import { looksLikeSend } from "../src/gmail.js";
import { errorReasonsOf } from "../src/google.js";
import { metadataBudget, readMessage, readThread, SEARCH_SUBREQUEST_BUDGET, searchMail } from "../src/mail.js";
import { GOOGLE_CLIENT, resetKv, seedAccount, testEnv } from "./helpers.js";

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

const EMAIL = "a@example.com";

/** The token endpoint, plus `handler` for every Gmail request; each Gmail URL is kept in `requests`. */
function gmail(handler: (url: URL) => Response) {
	const requests: { url: URL; method: string; host: string }[] = [];
	const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "oauth2.googleapis.com") {
			return Response.json({ access_token: "ya29.x", scope: REQUIRED_SCOPES.join(" ") });
		}
		requests.push({ url, method: init?.method ?? "GET", host: url.hostname });
		return handler(url);
	});
	return { spy, requests };
}

function errorBody(status: number, reason?: string, detail?: string): Response {
	return Response.json(
		{ error: { code: status, errors: reason ? [{ reason }] : [], details: detail ? [{ reason: detail }] : [] } },
		{ status },
	);
}

function metadataMessage(id: string, from = "Jane <jane@example.com>") {
	return {
		id,
		threadId: `t${id}`,
		labelIds: ["UNREAD", "INBOX"],
		snippet: "a snippet",
		internalDate: "1767225600000",
		payload: {
			headers: [
				{ name: "From", value: from },
				{ name: "Subject", value: "Hello" },
			],
		},
	};
}

async function search(options: Partial<Parameters<typeof searchMail>[3]> = {}) {
	await seedAccount(EMAIL, "1//r");
	return searchMail(testEnv, GOOGLE_CLIENT, EMAIL, { query: "is:unread", limit: 10, metadataBudget: 10, ...options });
}

describe("searchMail", () => {
	it("lists with the query as given, then fetches metadata with exact params", async () => {
		const { requests } = gmail((url) =>
			url.pathname.endsWith("/messages")
				? Response.json({ messages: [{ id: "a1", threadId: "ta1" }, { id: "b2" }] })
				: Response.json(metadataMessage(url.pathname.split("/").pop() as string)),
		);
		const result = await search({ query: "from:jane OR subject:(a b)", limit: 7 });

		const list = requests[0].url;
		expect(list.origin + list.pathname).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages");
		expect(list.searchParams.get("q")).toBe("from:jane OR subject:(a b)");
		expect(list.searchParams.get("maxResults")).toBe("7");
		expect(list.searchParams.has("includeSpamTrash")).toBe(false);

		const get = requests[1].url;
		expect(get.pathname).toBe("/gmail/v1/users/me/messages/a1");
		expect(get.searchParams.get("format")).toBe("metadata");
		expect(get.searchParams.getAll("metadataHeaders")).toEqual(["From", "To", "Subject"]);

		expect(result).toMatchObject({ email: EMAIL, truncated: false, vanished: 0 });
		expect(result.hits.map((hit) => hit.id)).toEqual(["a1", "b2"]);
		expect(result.hits[0]).toEqual({
			id: "a1",
			threadId: "ta1",
			from: "Jane <jane@example.com>",
			subject: "Hello",
			snippet: "a snippet",
			internalDate: 1767225600000,
			unread: true,
		});
	});

	it("omits q for an empty query", async () => {
		const { requests } = gmail(() => Response.json({}));
		await search({ query: "" });
		expect(requests[0].url.searchParams.has("q")).toBe(false);
	});

	it("only ever sends GETs to Gmail, none of them a send", async () => {
		const { requests } = gmail((url) =>
			url.pathname.endsWith("/messages")
				? Response.json({ messages: [{ id: "a1" }] })
				: Response.json(metadataMessage("a1")),
		);
		await search();
		expect(requests.length).toBe(2);
		for (const { url, method, host } of requests) {
			expect(host).toBe("gmail.googleapis.com");
			expect(method).toBe("GET");
			expect(looksLikeSend(url)).toBe(false);
		}
	});

	it("counts a listed message that vanished, rather than dropping it silently", async () => {
		gmail((url) =>
			url.pathname.endsWith("/messages")
				? Response.json({ messages: [{ id: "a1" }, { id: "gone" }] })
				: url.pathname.endsWith("/gone")
					? errorBody(404)
					: Response.json(metadataMessage("a1")),
		);
		const result = await search();
		expect(result.hits.map((hit) => hit.id)).toEqual(["a1"]);
		expect(result.vanished).toBe(1);
	});

	it("is truncated when Gmail has another page", async () => {
		gmail((url) =>
			url.pathname.endsWith("/messages")
				? Response.json({ messages: [{ id: "a1" }], nextPageToken: "more" })
				: Response.json(metadataMessage("a1")),
		);
		expect((await search()).truncated).toBe(true);
	});

	it("fetches headers for no more than its budget, and says it cut the result short", async () => {
		const { requests } = gmail((url) =>
			url.pathname.endsWith("/messages")
				? Response.json({ messages: ["a", "b", "c", "d"].map((id) => ({ id })) })
				: Response.json(metadataMessage(url.pathname.split("/").pop() as string)),
		);
		const result = await search({ metadataBudget: 2 });
		expect(requests.length).toBe(3);
		expect(result.hits.map((hit) => hit.id)).toEqual(["a", "b"]);
		expect(result.truncated).toBe(true);
	});

	it("an empty answer is an empty result, for an account that answered", async () => {
		gmail(() => Response.json({ resultSizeEstimate: 0 }));
		expect(await search()).toMatchObject({ hits: [], truncated: false, vanished: 0 });
	});

	it.each([
		[401, undefined, undefined, ReauthRequiredError],
		[403, "insufficientPermissions", undefined, ReauthRequiredError],
		[429, undefined, undefined, UpstreamUnavailableError],
		[503, undefined, undefined, UpstreamUnavailableError],
		[403, "domainPolicy", undefined, UpstreamUnavailableError],
		[400, "failedPrecondition", undefined, UpstreamUnavailableError],
	] as const)("maps %s %s from the list to an error class", async (status, reason, detail, errorClass) => {
		gmail(() => errorBody(status, reason, detail));
		await expect(search()).rejects.toBeInstanceOf(errorClass);
	});

	it("maps a 401 to revoked and a 429 to rate_limited", async () => {
		gmail(() => errorBody(401));
		await expect(search()).rejects.toMatchObject({ reason: "revoked" });
		gmail(() => errorBody(429));
		await expect(search()).rejects.toMatchObject({ reason: "rate_limited" });
	});

	it("maps a disabled Gmail API to misconfigured, naming it", async () => {
		gmail(() => errorBody(403, "accessNotConfigured", "SERVICE_DISABLED"));
		const error = await search().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(MisconfiguredError);
		expect((error as MisconfiguredError).missing).toEqual(["Gmail API"]);
	});

	it("maps a network failure to upstream unavailable", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).includes("oauth2"))
				return Response.json({ access_token: "t", scope: REQUIRED_SCOPES.join(" ") });
			throw new TypeError("network down");
		});
		await expect(search()).rejects.toBeInstanceOf(UpstreamUnavailableError);
	});

	it("treats a 200 that isn't a JSON object as unreadable", async () => {
		gmail(() => new Response("<html>"));
		await expect(search()).rejects.toMatchObject({ detail: "unreadable response" });
		gmail(() => Response.json([1, 2]));
		await expect(search()).rejects.toMatchObject({ detail: "unreadable response" });
	});

	it("needs only the mail scopes", async () => {
		await seedAccount("old@example.com", "1//r", [...MAIL_SCOPES]);
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input).includes("oauth2")
				? Response.json({ access_token: "t", scope: MAIL_SCOPES.join(" ") })
				: Response.json({}),
		);
		const result = await searchMail(testEnv, GOOGLE_CLIENT, "old@example.com", {
			query: "",
			limit: 1,
			metadataBudget: 1,
		});
		expect(result.hits).toEqual([]);
	});

	it("is reauth_required when the grant lacks a mail scope", async () => {
		await seedAccount(EMAIL, "1//r");
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({ access_token: "t", scope: MAIL_SCOPES[0] }),
		);
		await expect(
			searchMail(testEnv, GOOGLE_CLIENT, EMAIL, { query: "", limit: 1, metadataBudget: 1 }),
		).rejects.toMatchObject({ reason: "missing_scopes" });
	});
});

describe("metadataBudget", () => {
	it("shares the budget out and keeps five accounts at limit 25 within it", () => {
		expect(metadataBudget(1, 10)).toBe(10);
		expect(metadataBudget(5, 25)).toBe(7);
		expect(5 * (2 + metadataBudget(5, 25))).toBeLessThanOrEqual(SEARCH_SUBREQUEST_BUDGET);
		expect(metadataBudget(5, 3)).toBe(3);
	});

	it("never goes below one hit", () => {
		expect(metadataBudget(30, 25)).toBe(1);
	});
});

describe("a search across five accounts at the largest limit", () => {
	it("makes at most 45 requests and marks every account truncated", async () => {
		const emails = ["a", "b", "c", "d", "e"].map((name) => `${name}@example.com`);
		for (const email of emails) await seedAccount(email, "1//r");
		const ids = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` }));
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.hostname === "oauth2.googleapis.com") {
				return Response.json({ access_token: "t", scope: REQUIRED_SCOPES.join(" ") });
			}
			return url.pathname.endsWith("/messages")
				? Response.json({ messages: ids })
				: Response.json(metadataMessage(url.pathname.split("/").pop() as string));
		});
		const budget = metadataBudget(emails.length, 25);
		const results = await Promise.all(
			emails.map((email) =>
				searchMail(testEnv, GOOGLE_CLIENT, email, { query: "", limit: 25, metadataBudget: budget }),
			),
		);
		expect(spy.mock.calls.length).toBeLessThanOrEqual(SEARCH_SUBREQUEST_BUDGET);
		for (const result of results) {
			expect(result.hits).toHaveLength(budget);
			expect(result.truncated).toBe(true);
		}
	});
});

describe("readMessage", () => {
	it("requests the full format and parses the payload", async () => {
		const { requests } = gmail(() =>
			Response.json({
				id: "m1",
				threadId: "t1",
				snippet: "s",
				internalDate: "1767225600000",
				labelIds: [],
				payload: {
					mimeType: "text/plain",
					headers: [{ name: "Subject", value: "Hi" }, { name: 7 }, "junk"],
					body: { size: 4, data: "aGkh" },
				},
			}),
		);
		await seedAccount(EMAIL, "1//r");
		const result = await readMessage(testEnv, GOOGLE_CLIENT, EMAIL, "m1");
		expect(requests[0].url.pathname).toBe("/gmail/v1/users/me/messages/m1");
		expect(requests[0].url.searchParams.get("format")).toBe("full");
		expect(result).toMatchObject({
			message: { id: "m1", threadId: "t1", unread: false, payload: { headers: [{ name: "Subject", value: "Hi" }] } },
		});
	});

	it("falls back leniently for a response with no fields", async () => {
		gmail(() => Response.json({}));
		await seedAccount(EMAIL, "1//r");
		expect(await readMessage(testEnv, GOOGLE_CLIENT, EMAIL, "m1")).toMatchObject({
			message: { id: "m1", threadId: "", snippet: "", unread: false, payload: undefined },
		});
	});

	it.each([
		["a 404", () => errorBody(404)],
		["a 400 invalidArgument", () => errorBody(400, "invalidArgument")],
		["a 400 INVALID_ARGUMENT", () => errorBody(400, undefined, "INVALID_ARGUMENT")],
	])("%s is notFound", async (_name, respond) => {
		gmail(respond);
		await seedAccount(EMAIL, "1//r");
		expect(await readMessage(testEnv, GOOGLE_CLIENT, EMAIL, "m1")).toEqual({ notFound: true });
	});

	it("does not treat other 400s as not found", async () => {
		gmail(() => errorBody(400, "failedPrecondition"));
		await seedAccount(EMAIL, "1//r");
		await expect(readMessage(testEnv, GOOGLE_CLIENT, EMAIL, "m1")).rejects.toBeInstanceOf(UpstreamUnavailableError);
	});

	it("encodes the id into the path", async () => {
		const { requests } = gmail(() => Response.json({}));
		await seedAccount(EMAIL, "1//r");
		await readMessage(testEnv, GOOGLE_CLIENT, EMAIL, "a/b?c");
		expect(requests[0].url.pathname).toBe("/gmail/v1/users/me/messages/a%2Fb%3Fc");
	});
});

describe("readThread", () => {
	it("returns messages oldest first even when Gmail's order differs", async () => {
		const { requests } = gmail(() =>
			Response.json({
				id: "t1",
				messages: [
					{ id: "new", internalDate: "300" },
					{ id: "old", internalDate: "100" },
					{ id: "mid", internalDate: "200" },
					{ id: "undated" },
				],
			}),
		);
		await seedAccount(EMAIL, "1//r");
		const result = await readThread(testEnv, GOOGLE_CLIENT, EMAIL, "t1");
		expect(requests[0].url.pathname).toBe("/gmail/v1/users/me/threads/t1");
		expect(requests[0].url.searchParams.get("format")).toBe("full");
		expect("thread" in result && result.thread.messages.map((m) => m.id)).toEqual(["undated", "old", "mid", "new"]);
	});

	it("has no messages when Google sent none", async () => {
		gmail(() => Response.json({}));
		await seedAccount(EMAIL, "1//r");
		expect(await readThread(testEnv, GOOGLE_CLIENT, EMAIL, "t1")).toEqual({ thread: { id: "t1", messages: [] } });
	});

	it("is notFound on a 404", async () => {
		gmail(() => errorBody(404));
		await seedAccount(EMAIL, "1//r");
		expect(await readThread(testEnv, GOOGLE_CLIENT, EMAIL, "t1")).toEqual({ notFound: true });
	});
});

describe("errorReasonsOf", () => {
	it("reads the reasons without consuming the response", async () => {
		const response = errorBody(400, "invalidArgument", "INVALID_ARGUMENT");
		expect(await errorReasonsOf(response)).toEqual(["invalidArgument", "INVALID_ARGUMENT"]);
		expect(response.bodyUsed).toBe(false);
	});

	it("is empty for a body that isn't JSON", async () => {
		expect(await errorReasonsOf(new Response("<html>", { status: 400 }))).toEqual([]);
	});
});
