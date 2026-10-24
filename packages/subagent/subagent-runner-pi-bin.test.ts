import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "./agents.ts";
import { getFinalOutput, runSingleAgent } from "./runner.ts";
import type { SingleResult, SubagentDetails } from "./types.ts";

const agent: AgentConfig = {
	name: "worker",
	description: "Pi binary test worker",
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/worker.md",
};
const makeDetails = (results: SingleResult[]): SubagentDetails => ({
	mode: "single",
	inheritMainContext: false,
	projectAgentsDir: null,
	results,
});

let tmpDir: string;
let savedPiBin: string | undefined;
let savedPath: string | undefined;

/** Writes an executable that answers like `pi --mode json` with `label` as its reply. */
function writeFakePi(file: string, label: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const message = {
		role: "assistant",
		content: [{ type: "text", text: label }],
		stopReason: "stop",
		usage: { input: 0, output: 0, totalTokens: 0 },
	};
	const lines = [
		{ type: "agent_start" },
		{ type: "message_end", message },
		{ type: "agent_end", messages: [message] },
	].map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`);
	fs.writeFileSync(file, `#!/bin/sh\n${lines.join("\n")}\n`, { mode: 0o755 });
}

const run = () => runSingleAgent(tmpDir, [agent], "worker", "say hi", undefined, undefined, undefined, makeDetails);

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-bin-"));
	savedPiBin = process.env.PI_SUBAGENT_PI_BIN;
	savedPath = process.env.PATH;
	// `pi` on PATH resolves to a fake, so the default case never runs a real Pi.
	writeFakePi(path.join(tmpDir, "path-bin", "pi"), "from PATH pi");
	process.env.PATH = `${path.join(tmpDir, "path-bin")}${path.delimiter}${savedPath ?? ""}`;
});

afterEach(() => {
	if (savedPiBin === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
	else process.env.PI_SUBAGENT_PI_BIN = savedPiBin;
	process.env.PATH = savedPath;
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("PI_SUBAGENT_PI_BIN", () => {
	it("runs the configured executable, even when its path contains spaces", async () => {
		const custom = path.join(tmpDir, "Application Support", "picky pi");
		writeFakePi(custom, "from custom binary");
		process.env.PI_SUBAGENT_PI_BIN = custom;

		const result = await run();

		expect(result.exitCode).toBe(0);
		expect(getFinalOutput(result.messages)).toBe("from custom binary");
	});

	it.each([
		["unset", undefined],
		["empty", ""],
		["blank", "   "],
	])("falls back to pi on PATH when the variable is %s", async (_label, value) => {
		if (value === undefined) delete process.env.PI_SUBAGENT_PI_BIN;
		else process.env.PI_SUBAGENT_PI_BIN = value;

		const result = await run();

		expect(result.exitCode).toBe(0);
		expect(getFinalOutput(result.messages)).toBe("from PATH pi");
	});
});
