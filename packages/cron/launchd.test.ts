import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getLaunchdLabel,
	getLaunchdPlistPath,
	getLaunchdStatus,
	installLaunchAgent,
	uninstallLaunchAgent,
} from "./launchd.js";

let tempDir: string;
let previousAgentDir: string | undefined;
let previousPlistPath: string | undefined;
let previousLaunchctlBin: string | undefined;
let previousPiBin: string | undefined;

function writeFakeLaunchctl(exitCode = 0): string {
	const scriptPath = join(tempDir, "launchctl-fake.sh");
	writeFileSync(
		scriptPath,
		`#!/bin/sh
echo "$@" >> "${join(tempDir, "launchctl.log")}"
exit ${exitCode}
`,
		{ mode: 0o755 },
	);
	return scriptPath;
}

describe("launchd helpers", () => {
	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		previousPlistPath = process.env.PI_CRON_LAUNCHD_PLIST_PATH;
		previousLaunchctlBin = process.env.PI_CRON_LAUNCHCTL_BIN;
		previousPiBin = process.env.PI_CRON_PI_BIN;

		tempDir = join(tmpdir(), `pi-cron-launchd-test-${process.pid}-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = join(tempDir, "agent");
		process.env.PI_CRON_LAUNCHD_PLIST_PATH = join(tempDir, "LaunchAgents", "dev.pi.cron.plist");
		process.env.PI_CRON_LAUNCHCTL_BIN = writeFakeLaunchctl();
		process.env.PI_CRON_PI_BIN = "/tmp/fake pi & bin";
	});

	afterEach(() => {
		if (previousAgentDir === undefined) process.env.PI_CODING_AGENT_DIR = undefined;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousPlistPath === undefined) process.env.PI_CRON_LAUNCHD_PLIST_PATH = undefined;
		else process.env.PI_CRON_LAUNCHD_PLIST_PATH = previousPlistPath;
		if (previousLaunchctlBin === undefined) process.env.PI_CRON_LAUNCHCTL_BIN = undefined;
		else process.env.PI_CRON_LAUNCHCTL_BIN = previousLaunchctlBin;
		if (previousPiBin === undefined) process.env.PI_CRON_PI_BIN = undefined;
		else process.env.PI_CRON_PI_BIN = previousPiBin;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("uses an override plist path for tests", () => {
		expect(getLaunchdPlistPath()).toBe(join(tempDir, "LaunchAgents", "dev.pi.cron.plist"));
		expect(getLaunchdLabel()).toBe("dev.pi.cron");
	});

	it("reports installed and loaded status via launchctl print", () => {
		mkdirSync(join(tempDir, "LaunchAgents"), { recursive: true });
		writeFileSync(getLaunchdPlistPath(), "plist");
		expect(getLaunchdStatus()).toMatchObject({ installed: true, loaded: true, label: "dev.pi.cron" });
	});

	it("installs a LaunchAgent plist with escaped environment values", () => {
		const result = installLaunchAgent();
		if (process.platform !== "darwin") {
			expect(result.ok).toBe(false);
			expect(result.message).toContain("only supported on macOS");
			return;
		}

		expect(result.ok).toBe(true);
		expect(existsSync(getLaunchdPlistPath())).toBe(true);
		const plist = readFileSync(getLaunchdPlistPath(), "utf-8");
		expect(plist).toContain("<key>RunAtLoad</key>");
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toContain("/tmp/fake pi &amp; bin");

		const calls = readFileSync(join(tempDir, "launchctl.log"), "utf-8");
		expect(calls).toContain("bootstrap");
		expect(calls).toContain("kickstart -k");
	});

	it("uninstalls the LaunchAgent plist", () => {
		mkdirSync(join(tempDir, "LaunchAgents"), { recursive: true });
		writeFileSync(getLaunchdPlistPath(), "plist");
		const result = uninstallLaunchAgent();
		if (process.platform !== "darwin") {
			expect(result.ok).toBe(false);
			return;
		}

		expect(result.ok).toBe(true);
		expect(existsSync(getLaunchdPlistPath())).toBe(false);
	});
});
