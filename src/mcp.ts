// The protected /mcp route's tools. By the time this handler runs, the
// OAuth gate in src/gate.ts has already checked the bearer token.
//
// gmux is the hands, not the brain (AGENTS.md): tools reach Google and
// report accurately; they never summarise, digest or decide. The tools so
// far are a health check, list_accounts and read-only Drive search and read
// (src/drive.ts). Mail requests go through
// gmailFetch (src/gmail.ts), which refuses the send endpoints (GMX-4).

import { type CallToolResult, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Account, checkAccount, getAccount, listAccounts, normalizeEmail } from "./accounts.js";
import { readEncryptionKey, readGoogleClient, readSetupState } from "./config.js";
import { type DriveFile, readFile, type SearchResult, searchFiles } from "./drive.js";
import type { Env } from "./env.js";
import { toolError } from "./errors.js";
import { fanOut, renderFanOut } from "./fanout.js";

export const SERVER_VERSION = "0.1.0";

async function healthCheck(env: Env): Promise<CallToolResult> {
	const state = await readSetupState(env);
	const lines = [
		"gmux is running.",
		`Encryption key: ${state.encryptionKey ? "set" : "missing"}.`,
		`Google OAuth client: ${state.googleClient ? "configured" : "not configured"}.`,
	];
	return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Every connected account, each probed with a live token refresh through the fan-out. */
async function listAccountsTool(env: Env): Promise<CallToolResult> {
	try {
		readEncryptionKey(env);
		const client = await readGoogleClient(env);
		const accounts = await listAccounts(env.GMUX_KV);
		const outcome = await fanOut(accounts, (account) => checkAccount(env, client, account.email));
		return renderFanOut(outcome, () => "connected");
	} catch (error) {
		return toolError(error);
	}
}

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function fileLine(file: DriveFile): string {
	const parts = [
		file.name,
		file.mimeType,
		`modified ${file.modifiedTime ?? "unknown"}`,
		`owner ${file.owners.join(", ") || "unknown"}`,
		`id ${file.id}`,
	];
	if (file.webViewLink) parts.push(file.webViewLink);
	return `- ${parts.join(" | ")}`;
}

function renderSearch(result: SearchResult): string {
	const lines = result.files.length === 0 ? ["no matching files"] : result.files.map(fileLine);
	if (result.truncated) lines.push("more results exist; narrow the query");
	if (result.incompleteSearch) lines.push("Google reports this search as incomplete");
	return `\n${lines.join("\n")}`;
}

interface SearchArgs {
	query?: string;
	mime_type?: string;
	account?: string;
	limit: number;
}

/** Drive search over every connected account, or one, through the fan-out. */
async function driveSearchTool(env: Env, args: SearchArgs): Promise<CallToolResult> {
	try {
		readEncryptionKey(env);
		const client = await readGoogleClient(env);
		let accounts: Account[];
		if (args.account) {
			const account = await getAccount(env.GMUX_KV, args.account);
			if (!account) return errorResult(`No connected account named ${normalizeEmail(args.account)}.`);
			accounts = [account];
		} else {
			accounts = await listAccounts(env.GMUX_KV);
		}
		const outcome = await fanOut(accounts, (account) =>
			searchFiles(env, client, account.email, { query: args.query, mimeType: args.mime_type, pageSize: args.limit }),
		);
		return renderFanOut(outcome, renderSearch);
	} catch (error) {
		return toolError(error);
	}
}

/** One file's metadata, then its content, from one named account. */
async function driveReadFileTool(env: Env, args: { account: string; file_id: string }): Promise<CallToolResult> {
	try {
		readEncryptionKey(env);
		const client = await readGoogleClient(env);
		const account = await getAccount(env.GMUX_KV, args.account);
		if (!account) return errorResult(`No connected account named ${normalizeEmail(args.account)}.`);
		const result = await readFile(env, client, account.email, args.file_id);
		if (result.notFound) return errorResult(`No file with id ${args.file_id} is visible to ${account.email}.`);
		const { file, content } = result;
		const lines = [
			`Account: ${account.email}`,
			`Name: ${file.name}`,
			`Type: ${file.mimeType}`,
			`Modified: ${file.modifiedTime ?? "unknown"}`,
			`Owner: ${file.owners.join(", ") || "unknown"}`,
			`Size: ${file.size ? `${file.size} bytes` : "not reported"}`,
			`Id: ${file.id}`,
			...(file.webViewLink ? [`Link: ${file.webViewLink}`] : []),
			`Content: ${content.note}`,
		];
		if (content.text !== null) lines.push("", content.text);
		return { content: [{ type: "text", text: lines.join("\n") }] };
	} catch (error) {
		return toolError(error);
	}
}

/** A fresh McpServer per request, closing over `env` - the factory is handed no env of its own. */
function buildServer(env: Env): McpServer {
	const server = new McpServer({ name: "gmux", version: SERVER_VERSION });

	server.registerTool(
		"health_check",
		{
			title: "Health check",
			description: "Confirm gmux is reachable, and report which parts of its setup are complete.",
			inputSchema: z.strictObject({}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		},
		async () => healthCheck(env),
	);

	server.registerTool(
		"list_accounts",
		{
			title: "List accounts",
			description: "List every connected Google account with its label, email and whether gmux can reach it right now.",
			inputSchema: z.strictObject({}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		},
		async () => listAccountsTool(env),
	);

	server.registerTool(
		"drive_search",
		{
			title: "Search Drive",
			description:
				"Search Google Drive (shared drives included) across every connected account, or one with `account`. Each result block names the account it came from; files are in Google's own order. Accounts that couldn't be searched are listed first.",
			inputSchema: z.strictObject({
				query: z.string().optional().describe("Full-text search. Omit to list the most recently modified files."),
				mime_type: z.string().optional().describe("Only files of this MIME type."),
				account: z.string().optional().describe("Search only this connected account (its email)."),
				limit: z.number().int().min(1).max(50).default(20).describe("Files per account, 1 to 50."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		},
		async (args) => driveSearchTool(env, args),
	);

	server.registerTool(
		"drive_read_file",
		{
			title: "Read a Drive file",
			description:
				"Read one Drive file from one connected account: its metadata, then its content. Google Docs come back as markdown, Sheets as CSV of the first sheet, Slides as plain text, text files as stored. Other files return metadata only.",
			inputSchema: z.strictObject({
				account: z.string().describe("The connected account (its email) that can see the file."),
				file_id: z.string().min(1).describe("The Drive file id, as drive_search reports it."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
		},
		async (args) => driveReadFileTool(env, args),
	);

	return server;
}

export default {
	async fetch(request, env) {
		return createMcpHandler(() => buildServer(env)).fetch(request);
	},
} satisfies ExportedHandler<Env>;
