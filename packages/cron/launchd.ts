import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getDaemonPath } from "./daemon-client.ts";
import { ensureCronDirs, getAgentDir, getDaemonErrorLogPath, getDaemonLogPath } from "./store.ts";
import type { LaunchdStatus } from "./types.ts";

const LABEL = "dev.pi.cron";

export function getLaunchdLabel(): string {
	return LABEL;
}

export function getLaunchdPlistPath(): string {
	return process.env.PI_CRON_LAUNCHD_PLIST_PATH || join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function guiTarget(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	return uid === undefined ? LABEL : `gui/${uid}/${LABEL}`;
}

function guiDomain(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	return uid === undefined ? "gui" : `gui/${uid}`;
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function plistString(value: string): string {
	return `<string>${xmlEscape(value)}</string>`;
}

function runLaunchctl(args: string[]): { ok: boolean; output: string } {
	const launchctl = process.env.PI_CRON_LAUNCHCTL_BIN || "launchctl";
	const result = spawnSync(launchctl, args, { encoding: "utf-8" });
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
	return { ok: result.status === 0, output };
}

function resolvePiBinary(): string {
	if (process.env.PI_CRON_PI_BIN) return process.env.PI_CRON_PI_BIN;
	const result = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf-8" });
	const found = result.stdout.trim();
	return found || "pi";
}

function renderPlist(): string {
	const pathValue = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
	const piBin = resolvePiBinary();

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	${plistString(LABEL)}
	<key>ProgramArguments</key>
	<array>
		${plistString(process.execPath)}
		${plistString(getDaemonPath())}
	</array>
	<key>WorkingDirectory</key>
	${plistString(getAgentDir())}
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	${plistString(getDaemonLogPath())}
	<key>StandardErrorPath</key>
	${plistString(getDaemonErrorLogPath())}
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${plistString(pathValue)}
		<key>PI_CODING_AGENT_DIR</key>
		${plistString(getAgentDir())}
		<key>PI_CRON_PI_BIN</key>
		${plistString(piBin)}
	</dict>
</dict>
</plist>
`;
}

export function getLaunchdStatus(): LaunchdStatus {
	const plistPath = getLaunchdPlistPath();
	const print = runLaunchctl(["print", guiTarget()]);
	return {
		installed: existsSync(plistPath),
		loaded: print.ok,
		plistPath,
		label: LABEL,
	};
}

export function installLaunchAgent(): { ok: boolean; message: string } {
	if (process.platform !== "darwin") {
		return { ok: false, message: "launchd is only supported on macOS" };
	}

	ensureCronDirs();
	const plistPath = getLaunchdPlistPath();
	mkdirSync(dirname(plistPath), { recursive: true });
	writeFileSync(plistPath, renderPlist(), "utf-8");

	// Ignore bootout failures: the service may not be loaded yet.
	runLaunchctl(["bootout", guiDomain(), plistPath]);

	const bootstrap = runLaunchctl(["bootstrap", guiDomain(), plistPath]);
	if (!bootstrap.ok) {
		return { ok: false, message: `Failed to bootstrap ${LABEL}: ${bootstrap.output}` };
	}

	const kickstart = runLaunchctl(["kickstart", "-k", guiTarget()]);
	if (!kickstart.ok) {
		return { ok: false, message: `Installed ${LABEL}, but kickstart failed: ${kickstart.output}` };
	}

	return { ok: true, message: `launchd agent installed and started: ${plistPath}` };
}

export function uninstallLaunchAgent(): { ok: boolean; message: string } {
	if (process.platform !== "darwin") {
		return { ok: false, message: "launchd is only supported on macOS" };
	}

	const plistPath = getLaunchdPlistPath();
	const bootout = runLaunchctl(["bootout", guiDomain(), plistPath]);
	if (!bootout.ok && existsSync(plistPath)) {
		// Continue with file removal even if launchctl reports that it was not loaded.
	}

	try {
		if (existsSync(plistPath)) unlinkSync(plistPath);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}

	return { ok: true, message: `launchd agent uninstalled: ${plistPath}` };
}
