// The three ways reaching a Google account can fail, and describeError(),
// which gives each one a machine-matchable first line (`<code>: <name>`) and a
// sentence saying what to do about it. Copied in shape from ops-mail's
// errors.ts, deliberately not shared - see AGENTS.md.
//
// Nothing here maps to an empty result: a caller that can't reach an account
// throws one of these, and a fan-out across accounts names every one that
// failed (AGENTS.md's "A partial read never looks complete"). The three
// classes are also what the admin UI shows per account, so each sentence
// names the action to take, not just that something is wrong.

import type { CallToolResult } from "@modelcontextprotocol/server";

export type ReauthReason = "not_connected" | "unreadable" | "revoked" | "missing_scopes";

/** A missing, unreadable or revoked Google refresh token, or one lacking a scope gmux needs. Reconnecting fixes all four. */
export class ReauthRequiredError extends Error {
	constructor(
		public readonly account: string,
		public readonly reason: ReauthReason,
	) {
		super(`reauth_required: ${account}`);
		this.name = "ReauthRequiredError";
	}
}

/** Missing or invalid deployment configuration. Reconnecting an account would not help. */
export class MisconfiguredError extends Error {
	constructor(
		/** Names of what's missing or invalid - config names, never their values. */
		public readonly missing: string[],
		public readonly reason?: string,
	) {
		super(`misconfigured: ${missing.join(", ")}`);
		this.name = "MisconfiguredError";
	}
}

export type UpstreamUnavailableReason = "outage" | "rate_limited";

/** Google didn't answer, or answered in a way that isn't one of the cases above. Transient. */
export class UpstreamUnavailableError extends Error {
	constructor(
		public readonly account: string,
		public readonly reason: UpstreamUnavailableReason = "outage",
		/** Google's own error code or status, when readable. Safe to log or show - never a token or secret. */
		public readonly detail?: string,
	) {
		super(`upstream_unavailable: ${account}`);
		this.name = "UpstreamUnavailableError";
	}
}

export type ErrorCode = "reauth_required" | "misconfigured" | "upstream_unavailable";

export interface DescribedError {
	code: ErrorCode;
	firstLine: string;
	sentence: string;
}

function reauthSentence(account: string, reason: ReauthReason): string {
	const state = reason === "not_connected" ? "hasn't been connected yet" : "needs reconnecting";
	return `The ${account} account ${state}. Reconnect it from the gmux admin page, or remove it there.`;
}

function upstreamSentence(error: UpstreamUnavailableError): string {
	if (error.reason === "rate_limited") return "Google is rate-limiting this account. Try again in a few minutes.";
	if (error.detail) return `Google didn't answer just now (reason: ${error.detail}). Try again in a minute.`;
	return "Google didn't answer just now. Try again in a minute.";
}

function misconfiguredSentence(error: MisconfiguredError): string {
	const detail = error.reason ? `: ${error.reason}` : "";
	return `gmux isn't fully set up (${error.missing.join(", ")}${detail}). Reconnecting won't help; finish setup from the gmux admin page.`;
}

/**
 * The single place that turns one of the classes above into its described
 * shape. Returns undefined for anything else: an unrecognized error is a bug,
 * not something to invent a message for.
 */
export function describeError(error: unknown): DescribedError | undefined {
	if (error instanceof ReauthRequiredError) {
		return {
			code: "reauth_required",
			firstLine: error.message,
			sentence: reauthSentence(error.account, error.reason),
		};
	}
	if (error instanceof UpstreamUnavailableError) {
		return { code: "upstream_unavailable", firstLine: error.message, sentence: upstreamSentence(error) };
	}
	if (error instanceof MisconfiguredError) {
		return { code: "misconfigured", firstLine: error.message, sentence: misconfiguredSentence(error) };
	}
	return undefined;
}

/** Renders one of the classes above as an MCP tool error. Rethrows anything else. */
export function toolError(error: unknown): CallToolResult {
	const described = describeError(error);
	if (!described) throw error;
	return { content: [{ type: "text", text: `${described.firstLine}\n${described.sentence}` }], isError: true };
}

/**
 * The one-line `<firstLine> - <sentence>` form, for wherever several
 * accounts' errors sit inside one larger result. Rethrows anything else.
 */
export function errorLine(error: unknown): string {
	const described = describeError(error);
	if (!described) throw error;
	return `${described.firstLine} - ${described.sentence}`;
}
