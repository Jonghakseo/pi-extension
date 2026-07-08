export interface ParsedDelayArgs {
	durationText: string;
	delayMs: number;
	prompt: string;
}

const MAX_DELAY_MS = 2_147_483_647; // setTimeout's practical upper bound (~24.8 days)

const UNIT_TO_MS: Record<string, number> = {
	ms: 1,
	millisecond: 1,
	milliseconds: 1,
	msec: 1,
	msecs: 1,
	second: 1000,
	seconds: 1000,
	sec: 1000,
	secs: 1000,
	s: 1000,
	초: 1000,
	minute: 60_000,
	minutes: 60_000,
	min: 60_000,
	mins: 60_000,
	m: 60_000,
	분: 60_000,
	hour: 3_600_000,
	hours: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	h: 3_600_000,
	시간: 3_600_000,
	day: 86_400_000,
	days: 86_400_000,
	d: 86_400_000,
	일: 86_400_000,
};

const PART_RE =
	/(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|seconds?|secs?|sec|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|초|분|시간|일)/gi;

export function parseDurationMs(input: string): number | undefined {
	const text = input.trim();
	if (!text) return undefined;

	let cursor = 0;
	let total = 0;
	let matched = false;

	for (const match of text.matchAll(PART_RE)) {
		const index = match.index ?? 0;
		const between = text.slice(cursor, index);
		if (between.trim().length > 0) return undefined;

		const amount = Number(match[1]);
		const unit = match[2].toLowerCase();
		const unitMs = UNIT_TO_MS[unit];
		if (!Number.isFinite(amount) || amount <= 0 || !unitMs) return undefined;

		total += amount * unitMs;
		cursor = index + match[0].length;
		matched = true;
	}

	if (!matched || text.slice(cursor).trim().length > 0) return undefined;
	if (!Number.isFinite(total) || total <= 0 || total > MAX_DELAY_MS) return undefined;
	return Math.round(total);
}

export function isDurationToken(input: string): boolean {
	return parseDurationMs(input) !== undefined;
}

export function parseDelayArgs(args: string): ParsedDelayArgs | { error: string } {
	const trimmed = args.trim();
	if (!trimmed) return { error: "Usage: /delay <duration> <prompt>" };

	const tokens = trimmed.split(/\s+/);
	const durationTokens: string[] = [];
	let cursor = 0;
	for (const token of tokens) {
		if (!isDurationToken(token)) break;
		durationTokens.push(token);
		cursor += token.length;
		while (trimmed[cursor] === " " || trimmed[cursor] === "\t" || trimmed[cursor] === "\n") cursor++;
	}

	if (durationTokens.length === 0) {
		return { error: "첫 인자는 지연 시간이어야 해요. 예: /delay 5m 나중에 확인" };
	}

	const durationText = durationTokens.join(" ");
	const delayMs = parseDurationMs(durationText);
	if (delayMs === undefined) {
		return { error: "지연 시간을 해석할 수 없어요. 예: 30s, 5m, 1h, 1h30m, 2시간" };
	}

	const prompt = trimmed.slice(cursor).trim();
	if (!prompt) return { error: "지연 후 입력할 프롬프트를 함께 적어주세요. 예: /delay 5m 진행 상황 확인해줘" };

	return { durationText, delayMs, prompt };
}
