// Pure-function tests for src/mail-text.ts, ported from servers/mail's text tests.

import { describe, expect, it } from "vitest";
import {
	BODY_LINE_PREFIX,
	bodyNote,
	cleanBody,
	collectAttachments,
	decodeBase64Url,
	decodeHtmlEntities,
	fenceBody,
	formatAttachment,
	htmlToText,
	type MailPart,
	normalizeLineBreaks,
	pickBodyPart,
	plural,
	relativeTime,
	renderBody,
	sanitizeOneLine,
	senderName,
	stripQuotedText,
	truncateText,
} from "../src/mail-text.js";

function toBase64Url(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function part(fields: Partial<MailPart>): MailPart {
	return { headers: [], parts: [], ...fields };
}

describe("sanitizeOneLine", () => {
	it("collapses control characters and newlines to a single space", () => {
		expect(sanitizeOneLine("hello\r\nworld\tthere", 100)).toBe("hello world there");
	});

	it("caps at a word boundary and appends an ellipsis", () => {
		const result = sanitizeOneLine("one two three four five", 12);
		expect(result.length).toBeLessThanOrEqual(13);
		expect(result.endsWith("…")).toBe(true);
	});

	it.each([
		["CRLF", "\r\n"],
		["NEL", "\u0085"],
		["Line Separator", " "],
		["Paragraph Separator", " "],
		["vertical tab", "\v"],
		["form feed", "\f"],
	])("a %s can't be used to fake a second line", (_name, char) => {
		const result = sanitizeOneLine(`Invoice${char}reauth_required: project`, 200);
		expect(result.split("\n")).toHaveLength(1);
		expect(result).toBe("Invoice reauth_required: project");
	});
});

describe("normalizeLineBreaks", () => {
	it.each(["\r\n", "\r", "\u0085", " ", " ", "\v", "\f"])("collapses %j to a plain newline", (char) => {
		expect(normalizeLineBreaks(`a${char}b`)).toBe("a\nb");
	});
});

describe("decodeHtmlEntities", () => {
	it("decodes the named entities plus numeric decimal and hex", () => {
		expect(decodeHtmlEntities("Tom &amp; Jerry &lt;3&gt; &quot;ok&quot; &#39;y&#39; a&nbsp;b")).toBe(
			"Tom & Jerry <3> \"ok\" 'y' a b",
		);
		expect(decodeHtmlEntities("&#65;&#x42;")).toBe("AB");
		expect(decodeHtmlEntities("Don&rsquo;t &mdash; 50% off&hellip;")).toBe("Don’t — 50% off…");
	});

	it("leaves an unknown named entity alone", () => {
		expect(decodeHtmlEntities("&madeupentity;")).toBe("&madeupentity;");
	});

	it("removes zwnj, zwj and shy entirely", () => {
		expect(decodeHtmlEntities("a&zwnj;b&zwj;c&shy;d")).toBe("abcd");
	});
});

describe("htmlToText", () => {
	it("drops head, style, script and comments, and turns blocks into newlines", () => {
		const text = htmlToText(`<html><head><title>x</title><style>.a{color:red}</style></head>
			<body><!-- hidden --><p>Hello <b>world</b></p><script>evil()</script>
			<ul><li>one</li><li>two</li></ul><table><tr><td>a</td><td>b</td></tr></table></body></html>`);
		for (const gone of ["evil()", "color:red", "hidden", "<title>"]) expect(text).not.toContain(gone);
		expect(text).toContain("Hello world");
		expect(text).toContain("- one");
		expect(text).toContain("a b");
	});

	it("drops link targets but keeps the anchor text", () => {
		const text = htmlToText('<p>See <a href="https://example.com/x">our site</a> for more.</p>');
		expect(text).not.toContain("example.com");
		expect(text).toContain("our site");
	});

	it.each(["​", "‌", "‍", "﻿", "͏"])("strips the invisible character %j", (char) => {
		expect(htmlToText(`<p>Tom${char} &amp; Jerry${char}</p>`)).toBe("Tom & Jerry");
	});

	it("removes preheader padding", () => {
		const text = htmlToText("<div>Your receipt&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>");
		expect(text).not.toContain("&");
		expect(text).toContain("Your receipt");
	});

	it("collapses three or more newlines to two", () => {
		expect(htmlToText("<p>a</p>\n\n\n<p>b</p>\n\n\n<p>c</p>")).not.toMatch(/\n{3,}/);
	});
});

describe("pickBodyPart", () => {
	it("prefers text/plain over text/html", () => {
		const payload = part({
			mimeType: "multipart/alternative",
			parts: [
				part({ mimeType: "text/html", body: { data: toBase64Url("<p>html</p>") } }),
				part({ mimeType: "text/plain", body: { data: toBase64Url("plain text") } }),
			],
		});
		expect(pickBodyPart(payload)?.mimeType).toBe("text/plain");
	});

	it("falls back to text/html", () => {
		const payload = part({ mimeType: "text/html", body: { data: toBase64Url("<p>hi</p>") } });
		expect(pickBodyPart(payload)?.mimeType).toBe("text/html");
	});

	it("skips an attachment part, whether by filename or by disposition", () => {
		const payload = part({
			mimeType: "multipart/mixed",
			parts: [
				part({ mimeType: "text/plain", filename: "notes.txt", body: { data: toBase64Url("attachment content") } }),
				part({
					mimeType: "text/plain",
					headers: [{ name: "Content-Disposition", value: "attachment" }],
					body: { data: toBase64Url("also an attachment") },
				}),
				part({ mimeType: "text/plain", body: { data: toBase64Url("the real body") } }),
			],
		});
		expect(pickBodyPart(payload)?.data).toBe(toBase64Url("the real body"));
	});

	it("returns undefined when there's no text part", () => {
		expect(pickBodyPart(part({ mimeType: "image/png", filename: "x.png", body: { data: "abc" } }))).toBeUndefined();
	});
});

describe("decodeBase64Url", () => {
	it("round-trips UTF-8", () => {
		expect(decodeBase64Url(toBase64Url("héllo wörld"))).toBe("héllo wörld");
	});

	it("falls back to UTF-8 for an unknown charset", () => {
		expect(decodeBase64Url(toBase64Url("plain"), "made-up-charset")).toBe("plain");
	});

	it("decodes a non-UTF-8 charset", () => {
		// "caf" then 0xE9, which is "e acute" in ISO-8859-1 and invalid UTF-8.
		const latin1 = btoa(String.fromCharCode(0x63, 0x61, 0x66, 0xe9)).replace(/=+$/, "");
		expect(decodeBase64Url(latin1, "iso-8859-1")).toBe("café");
	});

	it("returns an empty string for data that isn't base64", () => {
		expect(decodeBase64Url("%%%")).toBe("");
	});
});

describe("stripQuotedText", () => {
	it("cuts at an 'On ... wrote:' line, even wrapped across lines", () => {
		const result = stripQuotedText(
			"Sure.\n\nOn Tue, Sep 23, 2025 at 1:00 PM Jane Doe\n<jane@example.com> wrote:\n> original",
		);
		expect(result).toEqual({ text: "Sure.", removed: true });
	});

	it("cuts at an Original Message banner and at an underscore rule", () => {
		expect(stripQuotedText("Reply\n-----Original Message-----\nFrom: Jane").text).toBe("Reply");
		expect(stripQuotedText("Reply\n__________\nFrom: Jane\nSent: today").text).toBe("Reply");
	});

	it("cuts at a From: line followed within three lines by Sent:", () => {
		expect(stripQuotedText("Reply\nFrom: Jane\nTo: Matt\nSent: Tuesday\nSubject: x").text).toBe("Reply");
	});

	it("cuts at the signature delimiter '-- ' but not at '--'", () => {
		expect(stripQuotedText("Thanks,\nMatt\n-- \nSent from my phone")).toEqual({ text: "Thanks,\nMatt", removed: true });
		expect(stripQuotedText("Thanks,\nMatt\n--\nSent from my phone")).toEqual({
			text: "Thanks,\nMatt\n--\nSent from my phone",
			removed: false,
		});
	});

	it("drops lines starting with >", () => {
		expect(stripQuotedText("New\n> quoted one\n> quoted two")).toEqual({ text: "New", removed: true });
	});

	it("keeps a forwarded message whole, with or without a comment", () => {
		const forwarded = [
			"---------- Forwarded message ---------",
			"From: Delta <noreply@delta.com>",
			"Date: Mon, Sep 22, 2025 at 3:04 PM",
			"Subject: Your itinerary",
			"",
			"Confirmation ABC123.",
		].join("\n");
		expect(stripQuotedText(forwarded)).toEqual({ text: forwarded, removed: false });
		const withComment = `Take a look.\n\n${forwarded}`;
		expect(stripQuotedText(withComment)).toEqual({ text: withComment, removed: false });
		const apple = "Begin forwarded message:\n\nFrom: Delta\nDate: Monday\n\nConfirmation ABC123.";
		expect(stripQuotedText(apple).removed).toBe(false);
	});

	it("keeps a body that is nothing but a quote", () => {
		const result = stripQuotedText("> only a quote\n> another");
		expect(result.text).toContain("only a quote");
		expect(result.removed).toBe(false);
	});

	it("leaves a plain body alone", () => {
		expect(stripQuotedText("Just a reply.")).toEqual({ text: "Just a reply.", removed: false });
	});
});

describe("truncateText", () => {
	it("leaves short text alone", () => {
		expect(truncateText("short", 100)).toEqual({ text: "short", removedChars: 0 });
	});

	it("cuts at a blank line past 60%, else a sentence end, else whitespace", () => {
		const a = "a".repeat(70);
		expect(truncateText(`${a}\n\n${"b".repeat(70)}`, 100).text).toBe(a);
		expect(truncateText(`${"a".repeat(65)}. ${"b".repeat(65)}`, 100).text.endsWith(".")).toBe(true);
		expect(truncateText(`${"a".repeat(99)} ${"b".repeat(99)}`, 100).text).toBe("a".repeat(99));
	});
});

describe("bodyNote", () => {
	it("is undefined when nothing was removed", () => {
		expect(bodyNote(false, 0)).toBeUndefined();
	});

	it("says how much was cut, with a thousands separator, and that a quote was removed", () => {
		expect(bodyNote(true, 3200)).toBe("[Earlier quoted text removed.] [Truncated: 3,200 more characters.]");
		expect(bodyNote(false, 10)).toBe("[Truncated: 10 more characters.]");
	});
});

describe("plural and relativeTime", () => {
	it("pluralises", () => {
		expect(plural(1, "message")).toBe("1 message");
		expect(plural(2, "message")).toBe("2 messages");
	});

	const now = Date.parse("2026-09-25T14:00:00.000Z");
	it.each([
		[30_000, "just now"],
		[90_000, "1 minute ago"],
		[3_600_000, "1 hour ago"],
		[86_400_000, "1 day ago"],
		[14 * 86_400_000, "2 weeks ago"],
	])("%d ms ago is %s", (delta, expected) => {
		expect(relativeTime(now - delta, now)).toBe(expected);
	});

	it("falls back to an absolute UTC date past 8 weeks", () => {
		expect(relativeTime(Date.parse("2025-09-12T09:00:00.000Z"), now)).toBe("on 12 Sep 2025");
	});
});

describe("cleanBody", () => {
	it("normalises a CRLF body before truncating, so the paragraph break is found and \\r isn't counted", () => {
		const first = "a".repeat(70);
		const payload = part({
			mimeType: "text/plain",
			body: { data: toBase64Url(`${first}\r\n\r\n${"b".repeat(70)}`) },
		});
		const result = cleanBody(payload, 100);
		expect(result?.text).toBe(first);
		expect(result?.note).toBe("[Truncated: 72 more characters.]");
	});

	it("cleans an HTML body and keeps a forwarded one whole", () => {
		const html =
			"---------- Forwarded message ---------<br>From: <b>Delta</b><br>Date: Monday<br><br><div>ABC123</div>";
		const result = cleanBody(part({ mimeType: "text/html", body: { data: toBase64Url(html) } }), 4000);
		expect(result?.text).toContain("Forwarded message");
		expect(result?.text).toContain("ABC123");
		expect(result?.note).toBeUndefined();
	});

	it("is undefined with no text part", () => {
		expect(cleanBody(part({ mimeType: "image/png" }), 100)).toBeUndefined();
		expect(cleanBody(undefined, 100)).toBeUndefined();
	});
});

describe("fencing", () => {
	it("prefixes every line, whichever way its break was spelled", () => {
		const fenced = fenceBody("one\rtwo three\r\nfour");
		expect(fenced.split("\n")).toEqual(["one", "two", "three", "four"].map((line) => `${BODY_LINE_PREFIX}${line}`));
	});

	it("renders a missing body, and a body's notes after it", () => {
		expect(renderBody(undefined)).toBe(`${BODY_LINE_PREFIX}(no readable message text)`);
		expect(renderBody({ text: "hi", note: "[Truncated: 5 more characters.]" })).toBe(
			`${BODY_LINE_PREFIX}hi\n[Truncated: 5 more characters.]`,
		);
	});
});

describe("senderName", () => {
	it("prefers the display name and falls back to the address", () => {
		expect(senderName('"Jane Doe" <jane@example.com>')).toBe("Jane Doe");
		expect(senderName("Jane Doe <jane@example.com>")).toBe("Jane Doe");
		expect(senderName("<jane@example.com>")).toBe("jane@example.com");
		expect(senderName("jane@example.com")).toBe("jane@example.com");
	});
});

describe("attachments", () => {
	it("formats name, type and size", () => {
		expect(formatAttachment("invoice.pdf", "application/pdf", 122_880)).toBe("invoice.pdf (application/pdf, 120 KB)");
		expect(formatAttachment("video.mp4", "video/mp4", 5 * 1024 * 1024)).toBe("video.mp4 (video/mp4, 5.0 MB)");
		expect(formatAttachment("x.bin", undefined, 10)).toBe("x.bin (1 KB)");
	});

	it("makes a hostile filename one line", () => {
		expect(formatAttachment("a\r\nreauth_required: x", "text/plain", 1024).split("\n")).toHaveLength(1);
	});

	it("collects every named part, nested ones too, without reading content", () => {
		const payload = part({
			mimeType: "multipart/mixed",
			parts: [
				part({ mimeType: "text/plain", body: { data: toBase64Url("hi") } }),
				part({ mimeType: "application/pdf", filename: "a.pdf", body: { size: 2048 } }),
				part({
					mimeType: "multipart/mixed",
					parts: [part({ mimeType: "image/png", filename: "b.png", body: { size: 1024 } })],
				}),
			],
		});
		expect(collectAttachments(payload)).toEqual(["a.pdf (application/pdf, 2 KB)", "b.png (image/png, 1 KB)"]);
	});
});
