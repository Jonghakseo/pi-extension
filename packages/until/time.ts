const INTERVAL_RE = /^(\d+(?:\.\d+)?)\s*(?:(m|h|분|시간)(?:마다)?)\s*$/i;

export function formatKoreanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}초`;
	if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}분`;

	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	if (minutes === 0) return `${hours}시간`;
	return `${hours}시간 ${minutes}분`;
}

export function formatClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("ko-KR", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export function parseInterval(raw: string): { ms: number; label: string } | null {
	const match = raw.trim().match(INTERVAL_RE);
	if (!match) return null;

	const amount = Number(match[1]);
	const unit = match[2].toLowerCase();
	if (!Number.isFinite(amount) || amount <= 0) return null;

	if (unit === "m" || unit === "분") return { ms: amount * 60_000, label: `${amount}분` };
	if (unit === "h" || unit === "시간") return { ms: amount * 3_600_000, label: `${amount}시간` };
	return null;
}
