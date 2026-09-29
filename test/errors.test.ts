import { describe, expect, it } from "vitest";
import {
	describeError,
	errorLine,
	MisconfiguredError,
	ReauthRequiredError,
	toolError,
	UpstreamUnavailableError,
} from "../src/errors.js";

describe("describeError", () => {
	it("tells a revoked account apart from a temporarily unavailable one", () => {
		const revoked = describeError(new ReauthRequiredError("work", "revoked"));
		const down = describeError(new UpstreamUnavailableError("work"));
		expect(revoked?.code).toBe("reauth_required");
		expect(down?.code).toBe("upstream_unavailable");
		expect(revoked?.sentence).toMatch(/Reconnect it .* or remove it/);
		expect(down?.sentence).toMatch(/Try again/);
	});

	it("says a never-connected account hasn't been connected", () => {
		expect(describeError(new ReauthRequiredError("home", "not_connected"))?.sentence).toContain(
			"hasn't been connected",
		);
	});

	it("says reconnecting won't fix a misconfiguration", () => {
		const described = describeError(new MisconfiguredError(["TOKEN_ENCRYPTION_KEY"]));
		expect(described?.firstLine).toBe("misconfigured: TOKEN_ENCRYPTION_KEY");
		expect(described?.sentence).toContain("Reconnecting won't help");
	});

	it("distinguishes rate limiting and passes Google's reason through", () => {
		expect(describeError(new UpstreamUnavailableError("a", "rate_limited"))?.sentence).toContain("rate-limiting");
		expect(describeError(new UpstreamUnavailableError("a", "outage", "backendError"))?.sentence).toContain(
			"backendError",
		);
	});

	it("returns undefined for anything else", () => {
		expect(describeError(new Error("boom"))).toBeUndefined();
	});
});

describe("toolError and errorLine", () => {
	it("render a machine-matchable first line", () => {
		const result = toolError(new ReauthRequiredError("work", "revoked"));
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^reauth_required: work\n/) });
		expect(errorLine(new UpstreamUnavailableError("home"))).toMatch(/^upstream_unavailable: home - /);
	});

	it("rethrow an unrecognized error instead of inventing a message", () => {
		const bug = new TypeError("bug");
		expect(() => toolError(bug)).toThrow(bug);
		expect(() => errorLine(bug)).toThrow(bug);
	});
});
