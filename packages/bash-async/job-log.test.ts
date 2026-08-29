import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	JobLog,
	type JobLogOptions,
	MAX_RAW_LOG_BYTES,
	MAX_RETAINED_LINES,
	MAX_RETAINED_TEXT_BYTES,
	MAX_RETURNED_BYTES,
	TRUNCATION_MARKER,
} from "./job-log.js";

const tempDirectories: string[] = [];
const logs: JobLog[] = [];

async function createLog(options: Omit<JobLogOptions, "path"> = {}) {
	const directory = await mkdtemp(join(tmpdir(), "bash-async-log-"));
	tempDirectories.push(directory);
	const log = new JobLog({ ...options, path: join(directory, "job.log") });
	logs.push(log);
	return log;
}

afterEach(async () => {
	for (const log of logs.splice(0)) log.close();
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("JobLog decoded tail", () => {
	it("decodes UTF-8 characters split across chunks", async () => {
		const log = await createLog();
		const data = Buffer.from("first 가\nsecond\n");
		log.append(data.subarray(0, 8));
		log.append(data.subarray(8, 10));
		log.append(data.subarray(10));

		expect(log.output({ lines: 10 }).lines).toEqual(["first 가", "second"]);
	});

	it("keeps stdout and stderr chunks in received order", async () => {
		const log = await createLog();
		log.append(Buffer.from("stdout one\n"));
		log.append(Buffer.from("stderr one\n"));
		log.append(Buffer.from("stdout two\n"));

		expect(log.tail(10)).toEqual(["stdout one", "stderr one", "stdout two"]);
	});

	it("retains the latest 2,000 lines with absolute offsets", async () => {
		const log = await createLog();
		for (let index = 0; index < MAX_RETAINED_LINES + 2; index++) log.append(`line ${index}\n`);

		const output = log.output({ outputOffset: 0, lines: 3 });
		expect(output.retainedFromOffset).toBe(2);
		expect(output.startOffset).toBe(2);
		expect(output.nextOffset).toBe(5);
		expect(output.lines).toEqual(["line 2", "line 3", "line 4"]);
		expect(output.warning).toContain("offset 2");
		expect(output.warning).toContain(output.logPath);
	});

	it("caps retained text at 1 MiB across the 2,000-line ring", async () => {
		const log = await createLog();
		for (let index = 0; index < MAX_RETAINED_LINES; index++) log.append(`${index}:${"x".repeat(1024)}\n`);

		const summary = log.summary();
		expect(MAX_RETAINED_TEXT_BYTES).toBe(1024 * 1024);
		expect(summary.retainedTextBytes).toBeLessThanOrEqual(MAX_RETAINED_TEXT_BYTES);
		expect(summary.retainedLineCount).toBeLessThan(MAX_RETAINED_LINES);
		expect(summary.retainedFromOffset).toBeGreaterThan(0);
		expect(log.tail(1)[0]).toBe(`${MAX_RETAINED_LINES - 1}:${"x".repeat(1024)}`);
		expect(log.output({ outputOffset: 0 }).warning).toContain(`offset ${summary.retainedFromOffset}`);
	});

	it("advances an incremental cursor without duplicating lines", async () => {
		const log = await createLog();
		log.append("zero\none\ntwo\nthree\n");

		expect(log.output({ lines: 2, incremental: true }).lines).toEqual(["zero", "one"]);
		expect(log.output({ lines: 2, incremental: true }).lines).toEqual(["two", "three"]);
		expect(log.output({ lines: 2, incremental: true }).lines).toEqual([]);
	});

	it("caps returned output at 200 lines and 5 KB", async () => {
		const log = await createLog();
		for (let index = 0; index < 250; index++) log.append(`${"가".repeat(100)} ${index}\n`);

		const output = log.output({ outputOffset: 0, lines: 250 });
		expect(output.lines.length).toBeLessThanOrEqual(200);
		expect(output.lines.length).toBeGreaterThan(0);
		expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(MAX_RETURNED_BYTES);
		expect(output.nextOffset).toBe(output.lines.length);
	});
});

describe("JobLog raw file cap and lifecycle", () => {
	it("uses a 20 MiB raw cap, writes one marker, and keeps decoding later output", async () => {
		expect(MAX_RAW_LOG_BYTES).toBe(20 * 1024 * 1024);
		const log = await createLog({ maxRawBytes: 160 });
		const acceptedBytes = 160 - Buffer.byteLength(TRUNCATION_MARKER);
		log.append(`first${"x".repeat(acceptedBytes - 6)}\n`);
		log.append("later\n");
		log.append("ignored raw but retained\n");
		log.close();

		expect(log.summary()).toMatchObject({ bytes: 160, truncated: true });
		expect((await stat(log.path)).size).toBe(160);
		const raw = await readFile(log.path, "utf8");
		expect(raw.match(/bash_async log truncated/g)).toHaveLength(1);
		expect(log.tail(2)).toEqual(["later", "ignored raw but retained"]);
	});

	it("seals and closes idempotently, ignoring later writes", async () => {
		const log = await createLog();
		log.append("before seal\n");
		log.seal();
		log.seal();
		log.append("after seal\n");
		log.close();
		log.close();

		expect(log.summary()).toMatchObject({ sealed: true, closed: true });
		expect(log.output({ lines: 10 }).lines).toEqual(["before seal"]);
		expect(await readFile(log.path, "utf8")).toBe("before seal\n");
	});
});

describe("JobLog bounded unterminated lines", () => {
	it("bounds a huge UTF-8 unterminated line while retaining continued output", async () => {
		const log = await createLog({ maxRawBytes: 256 });
		log.append("가".repeat(100_000));
		log.append(" continued\nnext\n");
		log.close();

		const [truncatedLine, next] = log.tail(2);
		expect(Buffer.byteLength(truncatedLine ?? "")).toBeLessThanOrEqual(64 * 1024);
		expect(truncatedLine).toContain("[bash_async in-memory line truncated]");
		expect(next).toBe("next");
	});
});
