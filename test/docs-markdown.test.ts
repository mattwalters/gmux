import { describe, expect, it } from "vitest";
import { docsToMarkdown } from "../src/docs-markdown.js";

const run = (content: string, textStyle: Record<string, unknown> = {}) => ({ textRun: { content, textStyle } });
const para = (elements: unknown[], extra: Record<string, unknown> = {}) => ({ paragraph: { elements, ...extra } });
const text = (content: string) => para([run(`${content}\n`)]);
const body = (...content: unknown[]) => ({ body: { content } });

describe("docsToMarkdown", () => {
	it("renders headings and plain paragraphs", () => {
		const doc = body(
			para([run("Title\n")], { paragraphStyle: { namedStyleType: "TITLE" } }),
			para([run("Section\n")], { paragraphStyle: { namedStyleType: "HEADING_2" } }),
			text("Body text."),
		);
		expect(docsToMarkdown(doc)).toBe("# Title\n\n## Section\n\nBody text.");
	});

	it("renders mixed bold, italic, strikethrough and link runs, keeping whitespace outside markers", () => {
		const doc = body(
			para([
				run("plain "),
				run("bold ", { bold: true }),
				run("both", { bold: true, italic: true }),
				run(" "),
				run("gone", { strikethrough: true }),
				run(" "),
				run("site", { link: { url: "https://example.com/a_(b)" } }),
				run("\n"),
			]),
		);
		expect(docsToMarkdown(doc)).toBe("plain **bold** ***both*** ~~gone~~ [site](https://example.com/a_(b%29)");
	});

	it("merges neighbouring runs of one style", () => {
		const doc = body(para([run("one", { bold: true }), run("two", { bold: true }), run("\n")]));
		expect(docsToMarkdown(doc)).toBe("**onetwo**");
	});

	it("escapes markdown-special characters", () => {
		expect(docsToMarkdown(body(text("a*b_c[d]e#f")))).toBe("a\\*b\\_c\\[d\\]e\\#f");
	});

	it("renders nested ordered and unordered lists", () => {
		const item = (label: string, listId: string, nestingLevel: number) =>
			para([run(`${label}\n`)], { bullet: { listId, nestingLevel } });
		const doc = {
			lists: {
				bul: { listProperties: { nestingLevels: [{ glyphSymbol: "●" }, { glyphSymbol: "○" }] } },
				num: { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }, { glyphType: "ALPHA" }] } },
			},
			body: {
				content: [
					item("a", "bul", 0),
					item("a1", "bul", 1),
					item("b", "bul", 0),
					text("between"),
					item("first", "num", 0),
					item("nested", "num", 1),
					item("second", "num", 0),
				],
			},
		};
		expect(docsToMarkdown(doc)).toBe(
			["- a", "    - a1", "- b", "", "between", "", "1. first", "    1. nested", "1. second"].join("\n"),
		);
	});

	it("renders a table as GFM, joining cell paragraphs with <br>", () => {
		const cell = (...lines: string[]) => ({ content: lines.map(text).map((block) => block) });
		const doc = body({
			table: {
				tableRows: [{ tableCells: [cell("Name"), cell("Notes")] }, { tableCells: [cell("x"), cell("one", "two")] }],
			},
		});
		expect(docsToMarkdown(doc)).toBe("| Name | Notes |\n| --- | --- |\n| x | one<br>two |");
	});

	it("renders rules, images and footnotes; drops page breaks", () => {
		const doc = {
			body: {
				content: [
					para([
						run("See"),
						{ footnoteReference: { footnoteId: "fn1", footnoteNumber: "1" } },
						run(" "),
						{ inlineObjectElement: {} },
						run("\n"),
					]),
					para([{ horizontalRule: {} }, run("\n")]),
					para([{ pageBreak: {} }, run("\n")]),
					{ sectionBreak: {} },
				],
			},
			footnotes: { fn1: { content: [text("The note.")] } },
		};
		expect(docsToMarkdown(doc)).toBe("See[^1] [image]\n\n---\n\n[^1]: The note.");
	});

	it("walks tabs, titling each when there is more than one", () => {
		const tab = (title: string, content: string, childTabs: unknown[] = []) => ({
			tabProperties: { title },
			documentTab: { body: { content: [text(content)] } },
			childTabs,
		});
		const doc = { tabs: [tab("One", "first", [tab("Child", "nested")]), tab("Two", "second")] };
		expect(docsToMarkdown(doc)).toBe("# One\n\nfirst\n\n## Child\n\nnested\n\n# Two\n\nsecond");
	});

	it("leaves a single tab untitled", () => {
		const doc = { tabs: [{ tabProperties: { title: "Only" }, documentTab: { body: { content: [text("hi")] } } }] };
		expect(docsToMarkdown(doc)).toBe("hi");
	});

	it("renders an empty document as an empty string", () => {
		expect(docsToMarkdown({})).toBe("");
		expect(docsToMarkdown(body({ sectionBreak: {} }, text("")))).toBe("");
	});
});
