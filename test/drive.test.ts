import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUIRED_SCOPES } from "../src/accounts.js";
import { CONTENT_LIMIT, driveFetch, escapeQueryValue, readFile, searchFiles } from "../src/drive.js";
import { MisconfiguredError, ReauthRequiredError, toolError, UpstreamUnavailableError } from "../src/errors.js";
import { apiError } from "../src/google.js";
import { GOOGLE_CLIENT, resetKv, seedAccount, testEnv } from "./helpers.js";

afterEach(async () => {
	vi.restoreAllMocks();
	await resetKv();
});

function errorBody(status: number, reason?: string, detail?: string): Response {
	return Response.json(
		{ error: { code: status, errors: reason ? [{ reason }] : [], details: detail ? [{ reason: detail }] : [] } },
		{ status },
	);
}

describe("apiError", () => {
	it.each([
		[401, undefined, undefined, ReauthRequiredError, "revoked"],
		[403, "insufficientPermissions", undefined, ReauthRequiredError, "missing_scopes"],
		[403, undefined, "ACCESS_TOKEN_SCOPE_INSUFFICIENT", ReauthRequiredError, "missing_scopes"],
		[429, undefined, undefined, UpstreamUnavailableError, "rate_limited"],
		[403, "rateLimitExceeded", undefined, UpstreamUnavailableError, "rate_limited"],
		[403, "userRateLimitExceeded", undefined, UpstreamUnavailableError, "rate_limited"],
		[503, undefined, undefined, UpstreamUnavailableError, "outage"],
		[418, undefined, undefined, UpstreamUnavailableError, "outage"],
		[403, "somethingNew", undefined, UpstreamUnavailableError, "outage"],
	] as const)("maps %s %s %s", async (status, reason, detail, errorClass, errorReason) => {
		const error = await apiError("a@example.com", errorBody(status, reason, detail), "Google Drive API");
		expect(error).toBeInstanceOf(errorClass);
		expect(error).toMatchObject({ reason: errorReason });
	});

	it.each([
		["accessNotConfigured", undefined],
		[undefined, "SERVICE_DISABLED"],
	])("maps a disabled API (%s %s) to misconfigured, naming the API", async (reason, detail) => {
		const error = await apiError("a@example.com", errorBody(403, reason, detail), "Google Docs API");
		expect(error).toBeInstanceOf(MisconfiguredError);
		expect((error as MisconfiguredError).missing).toEqual(["Google Docs API"]);
	});

	it("reports the status as detail for an unreadable body", async () => {
		const error = await apiError("a@example.com", new Response("<html>", { status: 502 }), "Google Drive API");
		expect((error as UpstreamUnavailableError).detail).toBe("HTTP 502");
	});

	it("leaves an unrecognised error for toolError to rethrow", () => {
		expect(() => toolError(new TypeError("bug"))).toThrow(TypeError);
	});
});

describe("driveFetch", () => {
	it("GETs Drive and Docs read paths with the bearer token", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
		await driveFetch("ya29.t", "/drive/v3/files?q=x");
		await driveFetch("ya29.t", "/v1/documents/abc?includeTabsContent=true");
		expect(String(fetchSpy.mock.calls[0][0])).toBe("https://www.googleapis.com/drive/v3/files?q=x");
		expect(String(fetchSpy.mock.calls[1][0])).toBe(
			"https://docs.googleapis.com/v1/documents/abc?includeTabsContent=true",
		);
		expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get("Authorization")).toBe("Bearer ya29.t");
	});

	it.each([
		"/batch",
		"/batch/drive/v3",
		"/upload/drive/v3/files",
		"/drive/v3/../gmail/v1/users/me/messages",
		"/drive/v3/%2e%2e/gmail/v1/users/me/messages",
		"/drive/v3/files/upload/x",
		"/drive/v3/batch",
		"/drive/v3/gmail",
		"/gmail/v1/users/me/messages",
		"https://evil.example.com/drive/v3/files",
		"https://gmail.googleapis.com/drive/v3/files",
		"/oauth2/v1/userinfo",
	])("refuses %s", async (path) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(driveFetch("t", path)).rejects.toThrow("gmux Drive code");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it.each(["POST", "PUT", "PATCH", "DELETE"])("refuses %s", async (method) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await expect(driveFetch("t", "/drive/v3/files", { method })).rejects.toThrow("read-only");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("query escaping", () => {
	it("escapes quotes and backslashes", () => {
		expect(escapeQueryValue("O'Brien")).toBe("O\\'Brien");
		expect(escapeQueryValue("a\\b")).toBe("a\\\\b");
	});
});

const DOC = "application/vnd.google-apps.document";

function google(handler: (url: URL) => Response) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.hostname === "oauth2.googleapis.com") {
			void init;
			return Response.json({ access_token: "ya29.x", scope: REQUIRED_SCOPES.join(" ") });
		}
		return handler(url);
	});
}

function meta(mimeType: string, extra: Record<string, unknown> = {}): Response {
	return Response.json({ id: "f1", name: "File", mimeType, ...extra });
}

async function read() {
	await seedAccount("a@example.com", "1//r");
	return readFile(testEnv, GOOGLE_CLIENT, "a@example.com", "f1");
}

describe("readFile", () => {
	it("returns notFound on a 404", async () => {
		google(() => Response.json({}, { status: 404 }));
		expect(await read()).toEqual({ notFound: true });
	});

	it("reads a Google Doc through the Docs API", async () => {
		const seen: string[] = [];
		google((url) => {
			seen.push(url.host + url.pathname);
			return url.hostname === "docs.googleapis.com" ? Response.json({ body: { content: [] } }) : meta(DOC);
		});
		const result = await read();
		expect(seen).toEqual(["www.googleapis.com/drive/v3/files/f1", "docs.googleapis.com/v1/documents/f1"]);
		expect(result).toMatchObject({ content: { text: "", note: "The document is empty." } });
	});

	it("exports a Sheet as CSV and says it is the first sheet", async () => {
		let exported: string | null = null;
		google((url) => {
			if (url.pathname.endsWith("/export")) {
				exported = url.searchParams.get("mimeType");
				return new Response("a,b\n1,2");
			}
			return meta("application/vnd.google-apps.spreadsheet");
		});
		const result = await read();
		expect(exported).toBe("text/csv");
		expect(result).toMatchObject({ content: { text: "a,b\n1,2" } });
		expect(JSON.stringify(result)).toContain("first sheet");
	});

	it("exports Slides as plain text", async () => {
		let exported: string | null = null;
		google((url) => {
			if (url.pathname.endsWith("/export")) {
				exported = url.searchParams.get("mimeType");
				return new Response("slide text");
			}
			return meta("application/vnd.google-apps.presentation");
		});
		await read();
		expect(exported).toBe("text/plain");
	});

	it("downloads text files, and truncates long ones", async () => {
		google((url) =>
			url.searchParams.get("alt") === "media" ? new Response("x".repeat(CONTENT_LIMIT + 5)) : meta("text/markdown"),
		);
		const result = await read();
		if (result.notFound) throw new Error("unexpected notFound");
		expect(result.content.text?.length).toBe(CONTENT_LIMIT);
		expect(result.content.truncated).toBe(true);
		expect(result.content.note).toContain("Truncated");
	});

	it("returns metadata only for a PDF, without downloading it", async () => {
		const fetchSpy = google(() => meta("application/pdf", { size: "1234" }));
		const result = await read();
		if (result.notFound) throw new Error("unexpected notFound");
		expect(result.content.text).toBeNull();
		expect(result.content.note).toContain("Content not read");
		expect(result.file.size).toBe("1234");
		expect(fetchSpy.mock.calls.filter(([input]) => String(input).includes("alt=media"))).toHaveLength(0);
	});

	it("maps a Docs API that is switched off to misconfigured", async () => {
		google((url) =>
			url.hostname === "docs.googleapis.com" ? errorBody(403, "accessNotConfigured", "SERVICE_DISABLED") : meta(DOC),
		);
		await expect(read()).rejects.toMatchObject({ missing: ["Google Docs API"] });
	});

	it("maps a network throw to upstream unavailable", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			if (String(input).includes("oauth2"))
				return Response.json({ access_token: "t", scope: REQUIRED_SCOPES.join(" ") });
			throw new TypeError("network");
		});
		await expect(read()).rejects.toBeInstanceOf(UpstreamUnavailableError);
	});
});

describe("searchFiles", () => {
	it("builds the list request with the documented parameters", async () => {
		await seedAccount("a@example.com", "1//r");
		let url: URL | undefined;
		google((u) => {
			url = u;
			return Response.json({ files: [], nextPageToken: "n" });
		});
		const result = await searchFiles(testEnv, GOOGLE_CLIENT, "a@example.com", {
			mimeType: "application/pdf",
			pageSize: 7,
		});
		expect(result).toEqual({ files: [], truncated: true, incompleteSearch: false });
		expect(url?.searchParams.get("q")).toBe("trashed = false and mimeType = 'application/pdf'");
		expect(url?.searchParams.get("orderBy")).toBe("modifiedTime desc");
		expect(url?.searchParams.get("corpora")).toBe("allDrives");
		expect(url?.searchParams.get("pageSize")).toBe("7");
	});
});
