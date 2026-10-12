export interface OpenAIUsageWindow {
	pct: number;
	resetsAt?: number;
}

export interface OpenAIModelLimit {
	name: string;
	fiveHour?: OpenAIUsageWindow;
	weekly?: OpenAIUsageWindow;
}

export interface OpenAIUsageData {
	planName?: string;
	fiveHour?: OpenAIUsageWindow;
	weekly?: OpenAIUsageWindow;
	modelLimits: OpenAIModelLimit[];
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as JsonObject
		: undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseWindow(value: unknown): OpenAIUsageWindow | undefined {
	const window = asObject(value);
	if (!window) return undefined;

	const usedPercent = asFiniteNumber(window.used_percent);
	if (usedPercent === undefined) return undefined;

	const resetAt = asFiniteNumber(window.reset_at);
	return {
		pct: Math.max(0, Math.min(100, usedPercent)),
		...(resetAt !== undefined ? { resetsAt: resetAt * 1000 } : {}),
	};
}

function parseWindowPair(value: unknown): Pick<OpenAIUsageData, "fiveHour" | "weekly"> {
	const rateLimit = asObject(value);
	if (!rateLimit) return {};

	const primary = parseWindow(rateLimit.primary_window);
	const secondary = parseWindow(rateLimit.secondary_window);
	const primarySeconds = asFiniteNumber(asObject(rateLimit.primary_window)?.limit_window_seconds);
	const secondarySeconds = asFiniteNumber(asObject(rateLimit.secondary_window)?.limit_window_seconds);

	const classify = (
		window: OpenAIUsageWindow | undefined,
		seconds: number | undefined,
		fallback: "fiveHour" | "weekly",
	): Pick<OpenAIUsageData, "fiveHour" | "weekly"> => {
		if (!window) return {};
		if (seconds === undefined) return { [fallback]: window };
		if (seconds === 18_000) return { fiveHour: window };
		if (seconds === 604_800) return { weekly: window };
		return {};
	};

	return {
		...classify(primary, primarySeconds, "fiveHour"),
		...classify(secondary, secondarySeconds, "weekly"),
	};
}

function getRateLimitObject(payload: JsonObject): JsonObject | undefined {
	const direct = asObject(payload.rate_limit);
	if (direct) return direct;

	const wrapped = asObject(payload.rate_limits);
	if (!wrapped) return undefined;
	return asObject(wrapped.rate_limit) ?? wrapped;
}

function getAdditionalRateLimits(payload: JsonObject): unknown[] {
	if (Array.isArray(payload.additional_rate_limits)) return payload.additional_rate_limits;
	const wrapped = asObject(payload.rate_limits);
	return Array.isArray(wrapped?.additional_rate_limits) ? wrapped.additional_rate_limits : [];
}

export function parseOpenAIUsage(payload: unknown): OpenAIUsageData | null {
	const object = asObject(payload);
	if (!object) return null;
	if (!("rate_limit" in object || "rate_limits" in object || "additional_rate_limits" in object || "plan_type" in object)) {
		return null;
	}

	const topLevel = parseWindowPair(getRateLimitObject(object));
	const planName = asNonEmptyString(object.plan_type);
	const modelLimits: OpenAIModelLimit[] = [];

	for (const rawLimit of getAdditionalRateLimits(object)) {
		const limit = asObject(rawLimit);
		if (!limit) continue;

		const details = asObject(limit.rate_limit) ?? asObject(limit.details) ?? limit;
		const windows = parseWindowPair(details);
		if (!windows.fiveHour && !windows.weekly) continue;

		const name = asNonEmptyString(limit.normal_model_slug)
			?? asNonEmptyString(limit.metered_feature)
			?? asNonEmptyString(limit.limit_name);
		if (!name) continue;

		modelLimits.push({ name, ...windows });
	}

	if (!topLevel.fiveHour && !topLevel.weekly && modelLimits.length === 0) return null;

	return {
		...(planName !== undefined ? { planName } : {}),
		...topLevel,
		modelLimits,
	};
}

export function parseOpenAIUsageHeaders(headers: Record<string, string>): OpenAIUsageData | null {
	const normalized = Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
	);

	const parseHeaderWindow = (prefix: "primary" | "secondary"): OpenAIUsageWindow | undefined => {
		const usedPercent = asFiniteNumber(normalized[`x-codex-${prefix}-used-percent`]);
		if (usedPercent === undefined) return undefined;

		const resetAt = asFiniteNumber(normalized[`x-codex-${prefix}-reset-at`]);
		const resetAfterSeconds = asFiniteNumber(normalized[`x-codex-${prefix}-reset-after-seconds`]);
		const resetsAt = resetAt !== undefined
			? resetAt * 1000
			: resetAfterSeconds !== undefined
				? Date.now() + resetAfterSeconds * 1000
				: undefined;

		return {
			pct: Math.max(0, Math.min(100, usedPercent)),
			...(resetsAt !== undefined ? { resetsAt } : {}),
		};
	};

	const fiveHour = parseHeaderWindow("primary");
	const weekly = parseHeaderWindow("secondary");
	if (!fiveHour && !weekly) return null;
	return { fiveHour, weekly, modelLimits: [] };
}

export function getOpenAIUsageEndpoint(provider: "openai" | "openai-codex"): string | undefined {
	return provider === "openai-codex"
		? "https://chatgpt.com/backend-api/wham/usage"
		: undefined;
}

export function isOpenAIUsageEligible(provider: string, isOAuth: boolean): boolean {
	return isOAuth && (provider === "openai" || provider === "openai-codex");
}

export function canUseOpenAICache(cachedAccountId: string | undefined, currentAccountId: string | undefined): boolean {
	return cachedAccountId !== undefined
		&& currentAccountId !== undefined
		&& cachedAccountId === currentAccountId;
}

export function getOpenAIAccountId(accessToken: string): string | undefined {
	const parts = accessToken.split(".");
	if (parts.length < 2) return undefined;

	try {
		const payload = asObject(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
		const auth = asObject(payload?.["https://api.openai.com/auth"]);
		return asNonEmptyString(auth?.chatgpt_account_id);
	} catch {
		return undefined;
	}
}
