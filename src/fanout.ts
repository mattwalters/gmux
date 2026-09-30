// Running one call per connected account, and reporting the outcome so a
// partial read never looks complete (AGENTS.md). A future mail tool's `all`
// fan-out must go through fanOut/renderFanOut and not assemble its own response.

import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Account } from "./accounts.js";
import { describeError, errorLine, MisconfiguredError } from "./errors.js";

export interface FanOut<T> {
	/** Every account asked, in input order. */
	accounts: Account[];
	results: { account: Account; value: T }[];
	failures: { account: Account; error: unknown }[];
}

/**
 * Runs `call` for every account concurrently. Reauth and upstream failures are
 * collected next to the results. A MisconfiguredError is deployment-wide and
 * is rethrown, as is anything unrecognised (a bug): neither is ever listed as
 * a per-account failure or swallowed into an empty result.
 */
export async function fanOut<T>(accounts: Account[], call: (account: Account) => Promise<T>): Promise<FanOut<T>> {
	const settled = await Promise.allSettled(accounts.map((account) => call(account)));
	const results: FanOut<T>["results"] = [];
	const failures: FanOut<T>["failures"] = [];
	settled.forEach((outcome, index) => {
		const account = accounts[index];
		if (outcome.status === "fulfilled") {
			results.push({ account, value: outcome.value });
			return;
		}
		const described = describeError(outcome.reason);
		if (!described || outcome.reason instanceof MisconfiguredError) throw outcome.reason;
		failures.push({ account, error: outcome.reason });
	});
	return { accounts, results, failures };
}

/** `label (email)` when the label differs from the email, otherwise the email. */
function accountName(account: Account): string {
	return account.label === account.email ? account.email : `${account.label} (${account.email})`;
}

function plural(count: number): string {
	return count === 1 ? "1 account" : `${count} accounts`;
}

/**
 * The one place that orders a fan-out response: the coverage statement first,
 * then every unreachable account (revoked before temporarily unavailable),
 * then the results. No accounts, or no account reachable, is an error.
 */
export function renderFanOut<T>(outcome: FanOut<T>, renderValue: (value: T) => string): CallToolResult {
	const total = outcome.accounts.length;
	if (total === 0) {
		return {
			content: [
				{
					type: "text",
					text: "No Google accounts are connected yet. Connect one from the gmux admin page.",
				},
			],
			isError: true,
		};
	}

	const lines: string[] = [];
	if (outcome.failures.length === 0) {
		lines.push(`All ${plural(total)} answered.`);
	} else {
		lines.push(`Partial result: ${outcome.failures.length} of ${plural(total)} could not be reached.`);
		const rank = (error: unknown) => (describeError(error)?.code === "reauth_required" ? 0 : 1);
		const ordered = outcome.failures
			.map((failure, index) => ({ failure, index }))
			.sort((a, b) => rank(a.failure.error) - rank(b.failure.error) || a.index - b.index);
		for (const { failure } of ordered) lines.push(`${accountName(failure.account)}: ${errorLine(failure.error)}`);
	}

	const allFailed = outcome.results.length === 0;
	if (!allFailed) {
		for (const { account, value } of outcome.results) {
			lines.push("", `${accountName(account)}: ${renderValue(value)}`);
		}
	}
	return { content: [{ type: "text", text: lines.join("\n") }], ...(allFailed ? { isError: true } : {}) };
}
