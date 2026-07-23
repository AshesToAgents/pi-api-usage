import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatResetTime, formatEpochReset, progressBar, isOAuthKey } from "./format.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type Provider = "anthropic" | "zai" | "minimax";

// Anthropic
interface AnthropicUsageWindow {
	utilization: number;
	resets_at: string | null;
}

interface AnthropicUsageResponse {
	five_hour: AnthropicUsageWindow | null;
	seven_day: AnthropicUsageWindow | null;
	seven_day_opus: AnthropicUsageWindow | null;
	seven_day_sonnet: AnthropicUsageWindow | null;
	extra_usage: {
		is_enabled: boolean;
		monthly_limit: number;
		used_credits: number;
		utilization: number;
	} | null;
}

// MiniMax
interface MiniMaxModelRemain {
	start_time: number;
	end_time: number;
	remains_time: number;
	current_interval_total_count: number;
	current_interval_usage_count: number;
	model_name: string;
	current_weekly_total_count: number;
	current_weekly_usage_count: number;
	weekly_start_time: number;
	weekly_end_time: number;
	weekly_remains_time: number;
}

interface MiniMaxUsageResponse {
	model_remains: MiniMaxModelRemain[];
	base_resp: {
		status_code: number;
		status_msg: string;
	};
}

interface MiniMaxUsageData {
	interval?: { pct: number; resetsAt: number };
	weekly?: { pct: number; resetsAt: number };
}

// Z.ai
interface ZaiLimit {
	type: "TOKENS_LIMIT" | "TIME_LIMIT";
	unit: number;
	number: number;
	usage: number;
	currentValue: number;
	remaining: number;
	percentage: number;
	nextResetTime?: number;
	usageDetails?: { modelCode: string; usage: number }[];
}

interface ZaiQuotaResponse {
	code: number;
	data: { limits: ZaiLimit[] };
	success: boolean;
}

interface ZaiSubscription {
	productName: string;
	nextRenewTime: string;
	status: string;
	inCurrentPeriod: boolean;
}

interface ZaiSubscriptionResponse {
	code: number;
	data: ZaiSubscription[];
	success: boolean;
}

interface ZaiUsageData {
	session?: { percentage: number; nextResetTime: number };
	weekly?: { percentage: number; nextResetTime: number };
	webSearches?: { used: number; limit: number; details: { modelCode: string; usage: number }[] };
	planName?: string;
	nextRenewTime?: string;
}

// Unified
type UsageData =
	| { provider: "anthropic"; data: AnthropicUsageResponse }
	| { provider: "zai"; data: ZaiUsageData }
	| { provider: "minimax"; data: MiniMaxUsageData };

// ─── Cache / State ───────────────────────────────────────────────────────────

interface CachedUsage {
	data: UsageData;
	fetchedAt: number;
}

const CACHE_DIR = join(process.env.HOME ?? "~", ".pi", "agent", "data");
const STATUS_KEY = "api-usage";
const COOLDOWN_MS = 60_000;

const providerState: Record<Provider, {
	cacheFile: string;
	lastFetchTime: number;
	lastData: UsageData | null;
	lastFetchFailed: boolean;
}> = {
	anthropic: {
		cacheFile: join(CACHE_DIR, "anthropic-usage-cache.json"),
		lastFetchTime: 0,
		lastData: null,
		lastFetchFailed: false,
	},
	zai: {
		cacheFile: join(CACHE_DIR, "zai-usage-cache.json"),
		lastFetchTime: 0,
		lastData: null,
		lastFetchFailed: false,
	},
	minimax: {
		cacheFile: join(CACHE_DIR, "minimax-usage-cache.json"),
		lastFetchTime: 0,
		lastData: null,
		lastFetchFailed: false,
	},
};

function loadCache(provider: Provider): void {
	const s = providerState[provider];
	try {
		const raw = readFileSync(s.cacheFile, "utf-8");
		const cached: CachedUsage = JSON.parse(raw);
		s.lastData = cached.data;
		s.lastFetchTime = cached.fetchedAt;
	} catch {
		// No cache or invalid — that's fine
	}
}

function saveCache(provider: Provider): void {
	const s = providerState[provider];
	if (!s.lastData) return;
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(s.cacheFile, JSON.stringify({ data: s.lastData, fetchedAt: s.lastFetchTime } satisfies CachedUsage));
	} catch {
		// Non-critical
	}
}

// ─── Provider detection ─────────────────────────────────────────────────────

const SUPPORTED_PROVIDERS: Provider[] = ["anthropic", "zai", "minimax"];

function getActiveProviders(ctx: ExtensionContext): Provider[] {
	const available = ctx.modelRegistry.getAvailable();
	return SUPPORTED_PROVIDERS.filter(p => available.some(m => m.provider === p));
}

function getCurrentProvider(ctx: ExtensionContext): Provider | null {
	const p = ctx.model?.provider;
	if (SUPPORTED_PROVIDERS.includes(p as Provider)) return p as Provider;
	return null;
}

function findModelForProvider(ctx: ExtensionContext, provider: Provider): Model<any> | undefined {
	return ctx.modelRegistry.getAvailable().find(m => m.provider === provider);
}

// ─── Header-based usage extraction ───────────────────────────────────────────

/**
 * Attempt to extract usage data from provider response headers.
 * Returns a UsageData if sufficient headers are present, or null if headers
 * don't contain enough information (fallback to fetch-based approach).
 *
 * Headers are normalized to lowercase by the pi extension system.
 */
function extractUsageFromHeaders(provider: Provider, headers: Record<string, string>): UsageData | null {
	if (provider === "anthropic") return extractAnthropicHeaders(headers);
	// MiniMax and Z.ai don't expose enough header data for percentage-based status
	return null;
}

function extractAnthropicHeaders(headers: Record<string, string>): UsageData | null {
	const get = (key: string) => headers[key];

	// Anthropic unified rate-limit headers (Claude Max / OAuth plans)
	const util5h = get("anthropic-ratelimit-unified-5h-utilization");
	const reset5h = get("anthropic-ratelimit-unified-5h-reset");
	const util7d = get("anthropic-ratelimit-unified-7d-utilization");
	const reset7d = get("anthropic-ratelimit-unified-7d-reset");

	const hasUnified = util5h != null || util7d != null;

	if (hasUnified) {
		const data: AnthropicUsageResponse = {
			five_hour: util5h != null
				? { utilization: parseFloat(util5h), resets_at: reset5h ? new Date(parseFloat(reset5h) * 1000).toISOString() : null }
				: null,
			seven_day: util7d != null
				? { utilization: parseFloat(util7d), resets_at: reset7d ? new Date(parseFloat(reset7d) * 1000).toISOString() : null }
				: null,
			seven_day_opus: null,
			seven_day_sonnet: null,
			extra_usage: null,
		};
		return { provider: "anthropic", data };
	}

	return null;
}

// ─── Anthropic fetch ─────────────────────────────────────────────────────────

async function fetchAnthropicUsage(ctx: ExtensionContext, quiet = false): Promise<UsageData | null> {
	const model = findModelForProvider(ctx, "anthropic");
	if (!model) {
		if (!quiet) ctx.ui.notify("No Anthropic model configured", "warning");
		providerState.anthropic.lastFetchFailed = true;
		return null;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		if (!quiet) ctx.ui.notify("No API key configured for Anthropic", "warning");
		providerState.anthropic.lastFetchFailed = true;
		return null;
	}
	if (!isOAuthKey(auth.apiKey)) {
		if (!quiet) ctx.ui.notify("Usage requires OAuth key (sk-ant-oat-*)", "warning");
		providerState.anthropic.lastFetchFailed = true;
		return null;
	}

	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			headers: {
				Authorization: `Bearer ${auth.apiKey}`,
				"anthropic-beta": "oauth-2025-04-20",
				"Content-Type": "application/json",
			},
		});
		if (!res.ok) {
			if (!quiet) {
				const msg = res.status === 429 ? "Rate limited while fetching usage" : `Usage fetch failed: HTTP ${res.status}`;
				ctx.ui.notify(msg, "warning");
			}
			providerState.anthropic.lastFetchFailed = true;
			return null;
		}
		providerState.anthropic.lastFetchFailed = false;
		const data = (await res.json()) as AnthropicUsageResponse;
		const usage: UsageData = { provider: "anthropic", data };
		providerState.anthropic.lastData = usage;
		providerState.anthropic.lastFetchTime = Date.now();
		saveCache("anthropic");
		return usage;
	} catch (e: any) {
		if (!quiet) ctx.ui.notify(`Usage fetch error: ${e.message}`, "warning");
		providerState.anthropic.lastFetchFailed = true;
		return null;
	}
}

// ─── Z.ai fetch ──────────────────────────────────────────────────────────────

async function fetchZaiUsage(ctx: ExtensionContext, quiet = false): Promise<UsageData | null> {
	let apiKey = process.env.ZAI_API_KEY ?? process.env.GLM_API_KEY;
	if (!apiKey) {
		const model = findModelForProvider(ctx, "zai");
		if (!model) {
			if (!quiet) ctx.ui.notify("No Z.ai model configured", "warning");
			providerState.zai.lastFetchFailed = true;
			return null;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			if (!quiet) ctx.ui.notify("No ZAI_API_KEY found. Set environment variable first.", "warning");
			providerState.zai.lastFetchFailed = true;
			return null;
		}
		apiKey = auth.apiKey;
	}

	const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

	try {
		const [quotaRes, subRes] = await Promise.all([
			fetch("https://api.z.ai/api/monitor/usage/quota/limit", { headers }),
			fetch("https://api.z.ai/api/biz/subscription/list", { headers }),
		]);

		if (!quotaRes.ok) {
			if (!quiet) {
				if (quotaRes.status === 401 || quotaRes.status === 403) {
					ctx.ui.notify("API key invalid. Check your Z.ai API key.", "warning");
				} else {
					ctx.ui.notify(`Usage request failed (HTTP ${quotaRes.status}). Try again later.`, "warning");
				}
			}
			providerState.zai.lastFetchFailed = true;
			return null;
		}

		providerState.zai.lastFetchFailed = false;
		const quota = (await quotaRes.json()) as ZaiQuotaResponse;

		let planName: string | undefined;
		let nextRenewTime: string | undefined;
		if (subRes.ok) {
			const sub = (await subRes.json()) as ZaiSubscriptionResponse;
			const active = sub.data?.find((s) => s.inCurrentPeriod || s.status === "VALID");
			if (active) {
				planName = active.productName;
				nextRenewTime = active.nextRenewTime;
			}
		}

		const usageData: ZaiUsageData = {};
		for (const limit of quota.data?.limits ?? []) {
			if (limit.type === "TOKENS_LIMIT") {
				if (limit.unit === 3 && limit.number === 5) {
					usageData.session = { percentage: limit.percentage, nextResetTime: limit.nextResetTime! };
				} else if (limit.unit === 6) {
					usageData.weekly = { percentage: limit.percentage, nextResetTime: limit.nextResetTime! };
				}
			} else if (limit.type === "TIME_LIMIT") {
				usageData.webSearches = {
					used: limit.currentValue,
					limit: limit.usage,
					details: limit.usageDetails ?? [],
				};
			}
		}
		usageData.planName = planName;
		usageData.nextRenewTime = nextRenewTime;

		const result: UsageData = { provider: "zai", data: usageData };
		providerState.zai.lastData = result;
		providerState.zai.lastFetchTime = Date.now();
		saveCache("zai");
		return result;
	} catch (e: any) {
		if (!quiet) ctx.ui.notify(`Usage fetch error: ${e.message}`, "warning");
		providerState.zai.lastFetchFailed = true;
		return null;
	}
}

// ─── MiniMax fetch ───────────────────────────────────────────────────────────

async function fetchMiniMaxUsage(ctx: ExtensionContext, quiet = false): Promise<UsageData | null> {
	const model = findModelForProvider(ctx, "minimax");
	if (!model) {
		if (!quiet) ctx.ui.notify("No MiniMax model configured", "warning");
		providerState.minimax.lastFetchFailed = true;
		return null;
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		if (!quiet) ctx.ui.notify("No API key configured for MiniMax", "warning");
		providerState.minimax.lastFetchFailed = true;
		return null;
	}

	try {
		const res = await fetch("https://api.minimax.io/v1/api/openplatform/coding_plan/remains", {
			headers: {
				Authorization: `Bearer ${auth.apiKey}`,
				Accept: "application/json",
			},
		});

		if (!res.ok) {
			if (!quiet) {
				const msg = res.status === 429
					? "Rate limited while fetching usage"
					: `Usage fetch failed: HTTP ${res.status}`;
				ctx.ui.notify(msg, "warning");
			}
			providerState.minimax.lastFetchFailed = true;
			return null;
		}

		providerState.minimax.lastFetchFailed = false;
		const body = (await res.json()) as MiniMaxUsageResponse;

		// Only care about MiniMax-M* text model entries
		const entry = body.model_remains?.find(
			(m) => m.model_name.startsWith("MiniMax-M"),
		);

		const usageData: MiniMaxUsageData = {};
		if (entry) {
				if (entry.current_interval_total_count > 0) {
					const remaining = entry.current_interval_usage_count / entry.current_interval_total_count;
					usageData.interval = {
						pct: Math.round((1 - remaining) * 100),
						resetsAt: entry.end_time,
					};
				}
				if (entry.current_weekly_total_count > 0) {
					const remaining = entry.current_weekly_usage_count / entry.current_weekly_total_count;
					usageData.weekly = {
						pct: Math.round((1 - remaining) * 100),
						resetsAt: entry.weekly_end_time,
					};
			}
		}

		const result: UsageData = { provider: "minimax", data: usageData };
		providerState.minimax.lastData = result;
		providerState.minimax.lastFetchTime = Date.now();
		saveCache("minimax");
		return result;
	} catch (e: any) {
		if (!quiet) ctx.ui.notify(`Usage fetch error: ${e.message}`, "warning");
		providerState.minimax.lastFetchFailed = true;
		return null;
	}
}

// ─── Unified fetch ───────────────────────────────────────────────────────────

async function fetchUsage(ctx: ExtensionContext, provider: Provider, quiet = false): Promise<UsageData | null> {
	if (provider === "anthropic") return fetchAnthropicUsage(ctx, quiet);
	if (provider === "zai") return fetchZaiUsage(ctx, quiet);
	if (provider === "minimax") return fetchMiniMaxUsage(ctx, quiet);
	return null;
}

async function fetchAllUsage(ctx: ExtensionContext, forceFetch = false): Promise<void> {
	const providers = getActiveProviders(ctx);
	for (const provider of providers) {
		const s = providerState[provider];
		if (!forceFetch && Date.now() - s.lastFetchTime < COOLDOWN_MS && s.lastData) {
			continue;
		}
		await fetchUsage(ctx, provider, true);
	}
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function colorForPct(pct: number, theme: any): (text: string) => string {
	if (pct > 80) return (t: string) => theme.fg("error", t);
	if (pct >= 50) return (t: string) => theme.fg("warning", t);
	return (t: string) => theme.fg("success", t);
}

// ─── Status bar line ─────────────────────────────────────────────────────────

function anthropicStatusLine(data: AnthropicUsageResponse, theme: any): string[] {
	const parts: string[] = [];
	if (data.five_hour) {
		const pct = Math.round(data.five_hour.utilization);
		parts.push(colorForPct(pct, theme)(`5hr: ${pct}%`));
	}
	if (data.seven_day) {
		const pct = Math.round(data.seven_day.utilization);
		parts.push(colorForPct(pct, theme)(`7d: ${pct}%`));
	}
	if (parts.length === 0) return [];
	let line = `Usage: ${parts.join(theme.fg("dim", " │ "))}`;
	if (providerState.anthropic.lastFetchFailed) line += theme.fg("dim", " (cached)");
	return [line];
}

function minimaxStatusLine(data: MiniMaxUsageData, theme: any): string[] {
	const parts: string[] = [];
	if (data.interval) {
		const pct = data.interval.pct;
		parts.push(colorForPct(pct, theme)(`5hr: ${pct}%`));
	}
	if (data.weekly) {
		const pct = data.weekly.pct;
		parts.push(colorForPct(pct, theme)(`7d: ${pct}%`));
	}
	if (parts.length === 0) return [];
	let line = `Usage: ${parts.join(theme.fg("dim", " │ "))}`;
	if (providerState.minimax.lastFetchFailed) line += theme.fg("dim", " (cached)");
	return [line];
}

function zaiStatusLine(data: ZaiUsageData, theme: any): string[] {
	const parts: string[] = [];
	if (data.session) {
		const pct = Math.round(data.session.percentage);
		parts.push(colorForPct(pct, theme)(`5hr: ${pct}%`));
	}
	if (data.weekly) {
		const pct = Math.round(data.weekly.percentage);
		parts.push(colorForPct(pct, theme)(`7d: ${pct}%`));
	}
	if (parts.length === 0) return [];
	let line = `Usage: ${parts.join(theme.fg("dim", " │ "))}`;
	if (providerState.zai.lastFetchFailed) line += theme.fg("dim", " (cached)");
	return [line];
}

function statusLine(usage: UsageData, theme: any): string[] {
	if (usage.provider === "anthropic") return anthropicStatusLine(usage.data as AnthropicUsageResponse, theme);
	if (usage.provider === "minimax") return minimaxStatusLine(usage.data as MiniMaxUsageData, theme);
	return zaiStatusLine(usage.data as ZaiUsageData, theme);
}

// ─── Status update ───────────────────────────────────────────────────────────

function updateStatus(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	const providers = getActiveProviders(ctx);
	if (providers.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const currentP = getCurrentProvider(ctx);
	// Sort so current provider is first
	const sorted = currentP && providers.includes(currentP)
		? [currentP, ...providers.filter(p => p !== currentP)]
		: providers;
	const lines: string[] = [];
	for (const provider of sorted) {
		const s = providerState[provider];
		if (!s.lastData) continue;
		const providerLines = statusLine(s.lastData, theme);
		if (providerLines.length > 0) {
			// Prefix with provider name for clarity when multiple providers are active
			if (providers.length > 1) {
				const label = provider === "zai" ? "Z.ai" : provider.charAt(0).toUpperCase() + provider.slice(1);
				lines.push(...providerLines.map(l => theme.fg("dim", `[${label}] `) + l));
			} else {
				lines.push(...providerLines);
			}
		}
	}
	ctx.ui.setStatus(STATUS_KEY, lines.length > 0 ? lines.join("\n") : undefined);
}

async function fetchAndUpdateStatus(ctx: ExtensionContext, forceFetch = false) {
	const providers = getActiveProviders(ctx);
	if (providers.length === 0) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}
	await fetchAllUsage(ctx, forceFetch);
	updateStatus(ctx);
}

// ─── /usage command renderers ────────────────────────────────────────────────

function renderAnthropicDetail(data: AnthropicUsageResponse, theme: any, isStale: boolean): string[] {
	const lines: string[] = [];

	let title = theme.bold(theme.fg("accent", "Anthropic API Usage"));
	if (isStale) {
		const ago = Math.round((Date.now() - providerState.anthropic.lastFetchTime) / 60_000);
		title += theme.fg("dim", `  (cached ${ago}m ago)`);
	}
	lines.push(title);
	lines.push(theme.fg("dim", "─".repeat(30)));

	if (data.five_hour) {
		const pct = Math.round(data.five_hour.utilization);
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatResetTime(data.five_hour.resets_at));
		lines.push(`5-Hour:   ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.seven_day) {
		const pct = Math.round(data.seven_day.utilization);
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatResetTime(data.seven_day.resets_at));
		lines.push(`7-Day:    ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.seven_day_sonnet) {
		const pct = Math.round(data.seven_day_sonnet.utilization);
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatResetTime(data.seven_day_sonnet.resets_at));
		lines.push(`Sonnet:   ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.seven_day_opus) {
		const pct = Math.round(data.seven_day_opus.utilization);
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatResetTime(data.seven_day_opus.resets_at));
		lines.push(`Opus:     ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.extra_usage) {
		const used = data.extra_usage.used_credits ?? 0;
		const limit = data.extra_usage.monthly_limit ?? 0;
		const enabled = data.extra_usage.is_enabled;
		const label = enabled
			? theme.fg("muted", `$${used.toFixed(2)} / $${limit.toFixed(2)}`)
			: theme.fg("dim", "disabled");
		lines.push(`Extra:    ${label}`);
	}

	return lines;
}

function renderZaiDetail(data: ZaiUsageData, theme: any, isStale: boolean): string[] {
	const lines: string[] = [];

	let title = theme.bold(theme.fg("accent", "Z.ai API Usage"));
	if (data.planName) title += theme.fg("dim", `  (${data.planName})`);
	if (isStale) {
		const ago = Math.round((Date.now() - providerState.zai.lastFetchTime) / 60_000);
		title += theme.fg("dim", `  (cached ${ago}m ago)`);
	}
	lines.push(title);
	lines.push(theme.fg("dim", "─".repeat(30)));

	if (data.session) {
		const pct = Math.round(data.session.percentage);
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatEpochReset(data.session.nextResetTime));
		lines.push(`Session:  ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.weekly) {
		const pct = Math.round(data.weekly.percentage);
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatEpochReset(data.weekly.nextResetTime));
		lines.push(`Weekly:   ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.webSearches) {
		const ws = data.webSearches;
		const pct = ws.limit > 0 ? Math.round((ws.used / ws.limit) * 100) : 0;
		const color = colorForPct(pct, theme);
		const count = theme.fg("muted", `${ws.used.toLocaleString()} / ${ws.limit.toLocaleString()}`);
		let resetLabel = "";
		if (data.nextRenewTime) {
			resetLabel = theme.fg("dim", `(resets ${new Date(data.nextRenewTime).toLocaleDateString([], { month: "short", day: "numeric" })})`);
		}
		lines.push(`Searches: ${color(progressBar(pct))}  ${count}  ${resetLabel}`);
	}

	return lines;
}

function renderMiniMaxDetail(data: MiniMaxUsageData, theme: any, isStale: boolean): string[] {
	const lines: string[] = [];

	let title = theme.bold(theme.fg("accent", "MiniMax API Usage"));
	if (isStale) {
		const ago = Math.round((Date.now() - providerState.minimax.lastFetchTime) / 60_000);
		title += theme.fg("dim", `  (cached ${ago}m ago)`);
	}
	lines.push(title);
	lines.push(theme.fg("dim", "─".repeat(30)));

	if (data.interval) {
		const pct = data.interval.pct;
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatEpochReset(data.interval.resetsAt));
		lines.push(`Interval: ${bar}  ${color(pct + "%")}  ${reset}`);
	}
	if (data.weekly) {
		const pct = data.weekly.pct;
		const color = colorForPct(pct, theme);
		const bar = color(progressBar(pct));
		const reset = theme.fg("dim", formatEpochReset(data.weekly.resetsAt));
		lines.push(`Weekly:   ${bar}  ${color(pct + "%")}  ${reset}`);
	}

	return lines;
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	loadCache("anthropic");
	loadCache("zai");
	loadCache("minimax");

	// /usage command — rich display
	pi.registerCommand("usage", {
		description: "Show API usage and rate limits for all active providers",
		handler: async (_args, ctx) => {
			const providers = getActiveProviders(ctx);
			if (providers.length === 0) {
				ctx.ui.notify("Usage tracking only supports Anthropic, Z.ai, and MiniMax models", "warning");
				return;
			}

			// Fetch fresh data for all providers
			const fetchedData: { provider: Provider; data: UsageData; isStale: boolean }[] = [];
			for (const provider of providers) {
				const freshData = await fetchUsage(ctx, provider, false);
				const s = providerState[provider];
				if (!freshData && !s.lastData) continue;
				fetchedData.push({ provider, data: freshData ?? s.lastData!, isStale: !freshData && !!s.lastData });
			}

			if (fetchedData.length === 0) {
				ctx.ui.notify("No usage data available for any provider", "warning");
				updateStatus(ctx);
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const allLines: string[] = [];

				for (const { provider, data: displayData, isStale } of fetchedData) {

					let lines: string[];
					if (displayData.provider === "anthropic") {
						lines = renderAnthropicDetail(displayData.data as AnthropicUsageResponse, theme, isStale);
					} else if (displayData.provider === "minimax") {
						lines = renderMiniMaxDetail(displayData.data as MiniMaxUsageData, theme, isStale);
					} else {
						lines = renderZaiDetail(displayData.data as ZaiUsageData, theme, isStale);
					}

					if (allLines.length > 0) allLines.push("");
					allLines.push(...lines);
				}

				allLines.push("");
				allLines.push(theme.fg("dim", "Press Escape to close"));

				const text = new Text(allLines.join("\n"), 1, 1);
				return {
					render: (width: number) => text.render(width),
					invalidate: () => text.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") {
							done();
						}
					},
				};
			});

			updateStatus(ctx);
		},
	});

	// Session start — show cached status immediately, then try to fetch fresh
	pi.on("session_start", async (_event, ctx) => {
		const providers = getActiveProviders(ctx);
		if (providers.length > 0) {
			updateStatus(ctx);
			await fetchAndUpdateStatus(ctx, true);
		}
	});

	// Agent end — refresh status with cooldown
	pi.on("agent_end", async (_event, ctx) => {
		await fetchAndUpdateStatus(ctx);
	});

	// After provider response — capture rate-limit headers to update status bar
	pi.on("after_provider_response", async (event, ctx) => {
		const provider = getCurrentProvider(ctx);
		if (!provider) return;

		// Only process successful responses
		if (event.status >= 400) return;

		const extracted = extractUsageFromHeaders(provider, event.headers);
		if (!extracted) return;

		const s = providerState[provider];
		s.lastData = extracted;
		s.lastFetchTime = Date.now();
		s.lastFetchFailed = false;
		saveCache(provider);
		updateStatus(ctx);
	});

	// Model select — show/hide status
	pi.on("model_select", async (_event, ctx) => {
		await fetchAndUpdateStatus(ctx);
	});
}
