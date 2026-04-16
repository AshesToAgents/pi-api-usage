import { describe, it, expect } from "vitest";
import { progressBar, isOAuthKey, formatResetTime, formatEpochReset } from "./format.js";

describe("progressBar", () => {
	it("renders full bar at 100%", () => {
		expect(progressBar(100, 5)).toBe("▓▓▓▓▓");
	});

	it("renders empty bar at 0%", () => {
		expect(progressBar(0, 5)).toBe("░░░░░");
	});

	it("renders partial bar", () => {
		expect(progressBar(50, 4)).toBe("▓▓░░");
	});

	it("clamps negative values", () => {
		expect(progressBar(-10, 3)).toBe("░░░");
	});

	it("clamps values over 100", () => {
		expect(progressBar(150, 3)).toBe("▓▓▓");
	});
});

describe("isOAuthKey", () => {
	it("returns true for OAuth keys", () => {
		expect(isOAuthKey("sk-ant-oat-abc123")).toBe(true);
	});

	it("returns false for regular API keys", () => {
		expect(isOAuthKey("sk-ant-api-key-here")).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(isOAuthKey("")).toBe(false);
	});
});

describe("formatResetTime", () => {
	it("returns empty string for null", () => {
		expect(formatResetTime(null)).toBe("");
	});

	it("returns expired for past dates", () => {
		expect(formatResetTime("2020-01-01T00:00:00Z")).toBe("(expired)");
	});
});
