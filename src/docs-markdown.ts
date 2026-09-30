// Google Docs API document JSON -> markdown. Pure: no I/O, no Google calls.
//
// Attribution: the approach (walk structural elements, map namedStyleType to
// heading levels, wrap styled text runs in markdown markers, GFM tables) follows
// a-bonus/google-docs-mcp (https://github.com/a-bonus/google-docs-mcp, MIT
// licence, its readDocument markdown format). Reimplemented here for the
// tabs-aware document shape; no code or dependency was copied.
//
// What it drops, and says so rather than hiding: page and section breaks carry
// no text and are omitted. Everything with text or a link is kept.

// biome-ignore lint/suspicious/noExplicitAny: the Docs API document is an untyped JSON tree, read defensively
type Json = any;

const HEADINGS: Record<string, number> = {
	TITLE: 1,
	SUBTITLE: 2,
	HEADING_1: 1,
	HEADING_2: 2,
	HEADING_3: 3,
	HEADING_4: 4,
	HEADING_5: 5,
	HEADING_6: 6,
};

const INDENT = "    ";

/** Backslash-escapes the characters markdown would otherwise read as formatting. */
export function escapeMarkdown(text: string): string {
	return text.replace(/[\\`*_[\]#~|]/g, "\\$&");
}

interface Style {
	bold: boolean;
	italic: boolean;
	strike: boolean;
	link: string | undefined;
}

interface Span {
	text: string;
	style: Style;
	/** Already markdown (an image marker, a footnote reference): not escaped, not merged. */
	raw?: boolean;
}

function styleOf(textStyle: Json): Style {
	const style = textStyle ?? {};
	const link = style.link?.url;
	return {
		bold: style.bold === true,
		italic: style.italic === true,
		strike: style.strikethrough === true,
		link: typeof link === "string" ? link : undefined,
	};
}

function sameStyle(a: Style, b: Style): boolean {
	return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.link === b.link;
}

/** One span's markdown. Whitespace stays outside the markers, since `** x**` isn't bold. */
function renderSpan({ text, style, raw }: Span): string {
	if (raw) return text;
	const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [text, "", text, ""];
	const [, lead, core, trail] = match;
	if (core === "") return text;
	let out = escapeMarkdown(core);
	if (style.strike) out = `~~${out}~~`;
	if (style.italic) out = `*${out}*`;
	if (style.bold) out = `**${out}**`;
	if (style.link) out = `[${out}](${style.link.replaceAll(")", "%29").replaceAll(" ", "%20")})`;
	return `${lead}${out}${trail}`;
}

/** Merges neighbouring spans of one style, so `**a****b**` never happens. */
function renderSpans(spans: Span[]): string {
	const merged: Span[] = [];
	for (const span of spans) {
		const last = merged[merged.length - 1];
		if (last && !last.raw && !span.raw && sameStyle(last.style, span.style)) last.text += span.text;
		else merged.push({ ...span });
	}
	return merged.map(renderSpan).join("");
}

interface Context {
	lists: Json;
	footnotes: Json;
	/** Footnote ids referenced so far, in order. */
	referenced: { id: string; number: string }[];
}

function paragraphInline(paragraph: Json, context: Context): string {
	const spans: Span[] = [];
	const plain = (text: string) => spans.push({ text, style: styleOf(undefined), raw: true });
	for (const element of paragraph.elements ?? []) {
		if (element.textRun) {
			// A vertical tab is Docs' soft line break.
			const text = String(element.textRun.content ?? "")
				.replace(/\n$/, "")
				.replaceAll("\u000b", "\n");
			spans.push({ text, style: styleOf(element.textRun.textStyle) });
		} else if (element.inlineObjectElement) {
			plain("[image]");
		} else if (element.footnoteReference) {
			const id = String(element.footnoteReference.footnoteId ?? "");
			const number = String(element.footnoteReference.footnoteNumber ?? context.referenced.length + 1);
			context.referenced.push({ id, number });
			plain(`[^${number}]`);
		} else if (element.richLink) {
			const props = element.richLink.richLinkProperties ?? {};
			const title = escapeMarkdown(String(props.title ?? props.uri ?? "link"));
			plain(props.uri ? `[${title}](${props.uri})` : title);
		} else if (element.person) {
			const props = element.person.personProperties ?? {};
			plain(escapeMarkdown(String(props.name ?? props.email ?? "person")));
		} else if (element.dateElement) {
			plain(escapeMarkdown(String(element.dateElement.dateElementProperties?.displayText ?? "date")));
		}
		// horizontalRule is handled by paragraphBlock; pageBreak, columnBreak
		// and autoText carry no text and are dropped.
	}
	return renderSpans(spans).replace(/\n/g, "  \n");
}

/** Whether a list level uses numbers or letters rather than a bullet glyph. */
function isOrdered(context: Context, listId: string, level: number): boolean {
	const glyphType = context.lists?.[listId]?.listProperties?.nestingLevels?.[level]?.glyphType;
	return typeof glyphType === "string" && glyphType !== "GLYPH_TYPE_UNSPECIFIED" && glyphType !== "NONE";
}

interface Block {
	text: string;
	list: boolean;
}

function paragraphBlock(paragraph: Json, context: Context): Block | undefined {
	const inline = paragraphInline(paragraph, context);
	if (inline.trim() === "") {
		const rule = (paragraph.elements ?? []).some((element: Json) => element.horizontalRule);
		return rule ? { text: "---", list: false } : undefined;
	}

	if (paragraph.bullet) {
		const level = Number(paragraph.bullet.nestingLevel ?? 0);
		const marker = isOrdered(context, String(paragraph.bullet.listId ?? ""), level) ? "1." : "-";
		return { text: `${INDENT.repeat(level)}${marker} ${inline.trim()}`, list: true };
	}
	const heading = HEADINGS[String(paragraph.paragraphStyle?.namedStyleType ?? "")];
	if (heading) return { text: `${"#".repeat(heading)} ${inline.trim()}`, list: false };
	return { text: inline.trim(), list: false };
}

function cellText(cell: Json, context: Context): string {
	const parts: string[] = [];
	for (const element of cell.content ?? []) {
		if (element.paragraph) {
			const inline = paragraphInline(element.paragraph, context).trim();
			if (inline) parts.push(inline.replace(/ {2}\n/g, "<br>"));
		} else if (element.table) {
			parts.push("[nested table]");
		}
	}
	return parts.join("<br>");
}

function tableBlock(table: Json, context: Context): Block | undefined {
	const rows: string[][] = (table.tableRows ?? []).map((row: Json) =>
		(row.tableCells ?? []).map((cell: Json) => cellText(cell, context)),
	);
	if (rows.length === 0) return undefined;
	const width = Math.max(...rows.map((row) => row.length), 1);
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
	const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
	return { text: [line(rows[0]), separator, ...rows.slice(1).map(line)].join("\n"), list: false };
}

function join(blocks: Block[]): string {
	let out = "";
	blocks.forEach((block, index) => {
		if (index > 0) out += blocks[index - 1].list && block.list ? "\n" : "\n\n";
		out += block.text;
	});
	return out;
}

/** The markdown for one body (a tab's, or a legacy document's), with its footnotes appended. */
function renderBody(body: Json, lists: Json, footnotes: Json): string {
	const context: Context = { lists, footnotes, referenced: [] };
	const blocks: Block[] = [];
	for (const element of body?.content ?? []) {
		const block = element.paragraph
			? paragraphBlock(element.paragraph, context)
			: element.table
				? tableBlock(element.table, context)
				: undefined;
		if (block) blocks.push(block);
	}
	// Footnote bodies are rendered after the body so references keep document order.
	const notes: Block[] = [];
	for (const { id, number } of context.referenced) {
		const note = footnotes?.[id];
		const text = (note?.content ?? [])
			.filter((element: Json) => element.paragraph)
			.map((element: Json) => paragraphInline(element.paragraph, context).trim())
			.filter(Boolean)
			.join(" ");
		notes.push({ text: `[^${number}]: ${text}`, list: true });
	}
	return [join(blocks), join(notes)].filter(Boolean).join("\n\n");
}

interface FlatTab {
	title: string;
	depth: number;
	documentTab: Json;
}

function flattenTabs(tabs: Json[], depth = 0): FlatTab[] {
	return tabs.flatMap((tab) => [
		{ title: String(tab.tabProperties?.title ?? "Untitled tab"), depth, documentTab: tab.documentTab },
		...flattenTabs(tab.childTabs ?? [], depth + 1),
	]);
}

/**
 * Renders a Docs API `documents.get` response as markdown. Walks `tabs[]`
 * (each tab's title becomes a heading when there's more than one), falling
 * back to the top-level `body` for a response without tabs. An empty document
 * is an empty string.
 */
export function docsToMarkdown(document: Json): string {
	const tabs = Array.isArray(document?.tabs) ? flattenTabs(document.tabs) : [];
	if (tabs.length === 0) return renderBody(document?.body, document?.lists, document?.footnotes);

	const showTitles = tabs.length > 1;
	const sections = tabs.map((tab) => {
		const body = renderBody(tab.documentTab?.body, tab.documentTab?.lists, tab.documentTab?.footnotes);
		if (!showTitles) return body;
		const heading = `${"#".repeat(Math.min(tab.depth + 1, 6))} ${escapeMarkdown(tab.title)}`;
		return body ? `${heading}\n\n${body}` : heading;
	});
	return sections.filter(Boolean).join("\n\n");
}
