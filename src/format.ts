export function formatResetTime(resetsAt: string | null): string {
	if (!resetsAt) return "";
	const d = new Date(resetsAt);
	const now = new Date();
	const diffMs = d.getTime() - now.getTime();
	if (diffMs < 0) return "(expired)";
	if (diffMs < 24 * 60 * 60 * 1000) {
		return `(resets ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
	}
	return `(resets ${d.toLocaleDateString([], { weekday: "short" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
}

export function formatEpochReset(epochMs: number): string {
	const d = new Date(epochMs);
	const now = new Date();
	const diffMs = d.getTime() - now.getTime();
	if (diffMs < 0) return "(expired)";
	if (diffMs < 24 * 60 * 60 * 1000) {
		return `(resets ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
	}
	return `(resets ${d.toLocaleDateString([], { weekday: "short" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`;
}

export function progressBar(pct: number, width: number = 10): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const filled = Math.round((clamped / 100) * width);
	return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function isOAuthKey(key: string): boolean {
	return key.startsWith("sk-ant-oat");
}
