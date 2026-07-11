/**
 * Shared time formatting helpers.
 *
 * Standard duration format: 시/분/초 (e.g. "1시간 2분 3초", "4분 5초", "12초").
 */

// ─── Internal Helpers ────────────────────────────────────────────────────────

function toSafeMs(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

// ─── Existing Functions ──────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(toSafeMs(ms) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}시간 ${minutes}분 ${seconds}초`;
	if (minutes > 0) return `${minutes}분 ${seconds}초`;
	return `${seconds}초`;
}

export function formatDurationBetween(start: Date | number, end: Date | number): string {
	const startMs = start instanceof Date ? start.getTime() : start;
	const endMs = end instanceof Date ? end.getTime() : end;
	return formatDuration(toSafeMs(endMs - startMs));
}

export function formatElapsedSince(startedAt: number, now = Date.now()): string {
	return formatDuration(toSafeMs(now - startedAt));
}

// ─── Delay / Duration Conversion ─────────────────────────────────────────────

/** Convert a numeric amount + Korean unit to milliseconds. */
export function toDelayMs(amount: number, unit: "초" | "분" | "시간"): number {
	if (unit === "초") return amount * 1000;
	if (unit === "시간") return amount * 60 * 60 * 1000;
	return amount * 60 * 1000; // 분
}

/**
 * Format milliseconds as a Korean duration string (shorter style).
 *
 * Unlike `formatDuration` which always shows 시간/분/초,
 * this picks the most natural unit: "5초", "3분", "2시간 10분".
 */
export function formatKoreanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}분`;

	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (minutes === 0) return `${hours}시간`;
	return `${hours}시간 ${minutes}분`;
}

/** Format a timestamp as a ko-KR 24-hour clock string, e.g. "14:05:30". */
export function formatClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

// ─── Session Replay Time (from subagent/replay.ts) ───────────────────────────

/** Safely parse a date value (number or string) into a Date, falling back to now. */
export function parseDateSafely(raw: unknown): Date {
	if (typeof raw === "number") {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d;
	}
	if (typeof raw === "string") {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d;
	}
	return new Date();
}

/** Format a Date as a compact time string, e.g. "14:05:30". */
export function formatReplayTime(date: Date): string {
	return date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

// ─── Epoch Conversion (from github-overlay.ts) ───────────────────────────────

/** Parse an ISO date string to epoch milliseconds, returning 0 on failure. */
export function toEpochMs(value: string | null): number {
	if (!value) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
