import type { CronJob } from "./types.ts";

function parseField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();

	for (const rawPart of field.split(",")) {
		const part = rawPart.trim();
		if (!part) throw new Error(`Empty cron field part in "${field}"`);

		const [rangeStr, stepStr] = part.split("/");
		const step = stepStr === undefined ? 1 : Number.parseInt(stepStr, 10);
		if (!Number.isInteger(step) || step < 1) {
			throw new Error(`Invalid step "${stepStr}" in field "${field}"`);
		}

		let lo: number;
		let hi: number;

		if (rangeStr === "*") {
			lo = min;
			hi = max;
		} else if (rangeStr.includes("-")) {
			const [rawLo, rawHi] = rangeStr.split("-");
			lo = Number.parseInt(rawLo, 10);
			hi = Number.parseInt(rawHi, 10);
		} else {
			lo = Number.parseInt(rangeStr, 10);
			hi = lo;
		}

		if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
			throw new Error(`Invalid value in field "${field}"`);
		}
		if (lo < min || hi > max || lo > hi) {
			throw new Error(`Value out of range in "${field}" (allowed ${min}-${max})`);
		}

		for (let value = lo; value <= hi; value += step) values.add(value);
	}

	return values;
}

function parseCronExpression(expression: string): [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>] {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`Invalid cron expression (expected 5 fields): "${expression}"`);
	}

	return [
		parseField(fields[0], 0, 59),
		parseField(fields[1], 0, 23),
		parseField(fields[2], 1, 31),
		parseField(fields[3], 1, 12),
		parseField(fields[4], 0, 6),
	];
}

export function matchesCron(expression: string, date: Date): boolean {
	const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCronExpression(expression);

	return (
		minutes.has(date.getMinutes()) &&
		hours.has(date.getHours()) &&
		daysOfMonth.has(date.getDate()) &&
		months.has(date.getMonth() + 1) &&
		daysOfWeek.has(date.getDay())
	);
}

export function validateCron(expression: string): string | null {
	try {
		matchesCron(expression, new Date());
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function nextCronRun(expression: string, from = new Date()): Date {
	const cursor = new Date(from);
	cursor.setSeconds(0, 0);
	cursor.setMinutes(cursor.getMinutes() + 1);

	const maxChecks = 60 * 24 * 366 * 5;
	for (let i = 0; i < maxChecks; i++) {
		if (matchesCron(expression, cursor)) return new Date(cursor);
		cursor.setMinutes(cursor.getMinutes() + 1);
	}

	throw new Error(`Could not find next run for cron expression: ${expression}`);
}

export function calculateNextRun(
	job: Pick<CronJob, "enabled" | "kind" | "schedule" | "runAt">,
	from = new Date(),
): string | undefined {
	if (!job.enabled) return undefined;

	if (job.kind === "cron") {
		if (!job.schedule) throw new Error("Cron job requires schedule");
		return nextCronRun(job.schedule, from).toISOString();
	}

	if (!job.runAt) throw new Error(`${job.kind} job requires runAt`);
	const runAt = new Date(job.runAt);
	if (Number.isNaN(runAt.getTime())) throw new Error(`Invalid runAt: ${job.runAt}`);
	return runAt.toISOString();
}

export function isDue(job: CronJob, now = new Date()): boolean {
	if (!job.enabled) return false;
	if (!job.nextRunAt) return false;
	const nextRunAt = new Date(job.nextRunAt);
	return !Number.isNaN(nextRunAt.getTime()) && nextRunAt.getTime() <= now.getTime();
}
