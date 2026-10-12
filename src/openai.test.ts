import { describe, expect, it } from "vitest";
import {
	canUseOpenAICache,
	getOpenAIAccountId,
	isOpenAIUsageEligible,
	getOpenAIUsageEndpoint,
	parseOpenAIUsage,
	parseOpenAIUsageHeaders,
} from "./openai.js";

describe("parseOpenAIUsage", () => {
	it("parses five-hour and weekly windows with epoch-second resets", () => {
		const usage = parseOpenAIUsage({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 42.5, reset_at: 1_700_000_000 },
				secondary_window: { used_percent: 10, reset_at: 1_700_604_800 },
			},
		});

		expect(usage).toEqual({
			planName: "pro",
			fiveHour: { pct: 42.5, resetsAt: 1_700_000_000_000 },
			weekly: { pct: 10, resetsAt: 1_700_604_800_000 },
			modelLimits: [],
		});
	});

	it("keeps valid windows when the secondary window is absent", () => {
		const usage = parseOpenAIUsage({
			rate_limit: {
				primary_window: { used_percent: 101, reset_at: 1_700_000_000 },
				secondary_window: null,
			},
		});

		expect(usage?.fiveHour).toEqual({ pct: 100, resetsAt: 1_700_000_000_000 });
		expect(usage?.weekly).toBeUndefined();
		expect(usage?.modelLimits).toEqual([]);
	});

	it("uses the window duration when a plan puts weekly usage in primary_window", () => {
		const usage = parseOpenAIUsage({
			rate_limit: {
				primary_window: { used_percent: 34, limit_window_seconds: 604800, reset_at: 1_700_604_800 },
				secondary_window: null,
			},
		});

		expect(usage?.fiveHour).toBeUndefined();
		expect(usage?.weekly).toEqual({ pct: 34, resetsAt: 1_700_604_800_000 });
	});

	it("rejects an unrecognized successful response", () => {
		expect(parseOpenAIUsage({ error: "temporary proxy response" })).toBeNull();
	});

	it("rejects a recognized response with no usable limits", () => {
		expect(parseOpenAIUsage({ plan_type: "pro" })).toBeNull();
	});

	it("parses additional model-specific rate limits", () => {
		const usage = parseOpenAIUsage({
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 20 } },
			additional_rate_limits: [
				{
					metered_feature: "codex-spark",
					limit_name: "Codex Spark",
					normal_model_slug: "gpt-5.3-codex-spark",
					rate_limit: {
						primary_window: { used_percent: 75, reset_at: 1_700_000_000 },
						secondary_window: { used_percent: 80, reset_at: 1_700_604_800 },
					},
				},
			],
		});

		expect(usage?.modelLimits).toEqual([
			{
				name: "gpt-5.3-codex-spark",
				fiveHour: { pct: 75, resetsAt: 1_700_000_000_000 },
				weekly: { pct: 80, resetsAt: 1_700_604_800_000 },
			},
		]);
	});

	it("ignores malformed model windows instead of reporting zero usage", () => {
		const usage = parseOpenAIUsage({
			rate_limit: { primary_window: { used_percent: 10 } },
			additional_rate_limits: [
				{
					limit_name: "Unavailable",
					rate_limit: { primary_window: { used_percent: "unknown" } },
				},
			],
		});

		expect(usage?.modelLimits).toEqual([]);
	});
});

describe("parseOpenAIUsageHeaders", () => {
	it("parses Codex quota headers from a normal model response", () => {
		const usage = parseOpenAIUsageHeaders({
			"x-codex-primary-used-percent": "42.5",
			"x-codex-primary-reset-at": "1700000000",
			"x-codex-secondary-used-percent": "10",
			"x-codex-secondary-reset-at": "1700604800",
		});

		expect(usage).toEqual({
			fiveHour: { pct: 42.5, resetsAt: 1_700_000_000_000 },
			weekly: { pct: 10, resetsAt: 1_700_604_800_000 },
			modelLimits: [],
		});
	});

	it("returns null when a response has no Codex quota headers", () => {
		expect(parseOpenAIUsageHeaders({ "x-ratelimit-remaining-requests": "99" })).toBeNull();
	});
});

describe("getOpenAIUsageEndpoint", () => {
	it("does not expose an unsupported quota endpoint for native openai OAuth", () => {
		expect(getOpenAIUsageEndpoint("openai")).toBeUndefined();
	});

	it("uses the ChatGPT backend for the legacy openai-codex provider", () => {
		expect(getOpenAIUsageEndpoint("openai-codex")).toBe("https://chatgpt.com/backend-api/wham/usage");
	});
});

describe("isOpenAIUsageEligible", () => {
	it("allows OAuth OpenAI providers only", () => {
		expect(isOpenAIUsageEligible("openai", true)).toBe(true);
		expect(isOpenAIUsageEligible("openai-codex", true)).toBe(true);
		expect(isOpenAIUsageEligible("openai", false)).toBe(false);
		expect(isOpenAIUsageEligible("anthropic", true)).toBe(false);
	});
});

describe("canUseOpenAICache", () => {
	it("accepts cached usage only for the same known account", () => {
		expect(canUseOpenAICache("acct_123", "acct_123")).toBe(true);
	});

	it("rejects missing or mismatched account IDs", () => {
		expect(canUseOpenAICache(undefined, "acct_123")).toBe(false);
		expect(canUseOpenAICache("acct_123", undefined)).toBe(false);
		expect(canUseOpenAICache("acct_123", "acct_456")).toBe(false);
	});
});

describe("getOpenAIAccountId", () => {
	it("extracts the ChatGPT account id from the OAuth JWT", () => {
		const payload = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
		})).toString("base64url");
		const token = `header.${payload}.signature`;

		expect(getOpenAIAccountId(token)).toBe("acct_123");
	});

	it("returns undefined for a token without an account id", () => {
		expect(getOpenAIAccountId("not-a-jwt")).toBeUndefined();
	});
});
