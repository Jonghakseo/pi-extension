import { existsSync } from "node:fs";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ShellOptions {
	shellPath?: string;
	commandPrefix?: string;
}

export interface ShellEnvironment {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	readSettings?: (cwd: string, projectTrusted: boolean) => ShellOptions;
}

/** Homebrew installs bash 5 here; macOS's own /bin/bash is 3.2 and lacks mapfile and associative arrays. */
export const MODERN_BASH_CANDIDATES = ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"];

/**
 * Project settings count only when pi trusts the project, as in pi itself: otherwise a project-level
 * shellPath would run any binary a cloned repository names.
 */
function readPiSettings(cwd: string, projectTrusted: boolean): ShellOptions {
	try {
		const settings = SettingsManager.create(cwd, undefined, { projectTrusted });
		return { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
	} catch {
		return {};
	}
}

/**
 * Picks the shell the way pi's built-in bash does, except that on macOS a Homebrew bash replaces /bin/bash
 * when nothing is configured. PI_ENHANCED_BASH_SHELL overrides everything, so `/bin/bash` restores pi's choice.
 */
export function resolveShellOptions(
	cwd: string,
	environment: ShellEnvironment = {},
	projectTrusted = false,
): ShellOptions {
	const env = environment.env ?? process.env;
	const platform = environment.platform ?? process.platform;
	const exists = environment.exists ?? existsSync;
	const settings = (environment.readSettings ?? readPiSettings)(cwd, projectTrusted);
	const override = env.PI_ENHANCED_BASH_SHELL?.trim();
	if (override) return { ...settings, shellPath: override };
	if (settings.shellPath) return settings;
	if (platform === "darwin") {
		const modern = MODERN_BASH_CANDIDATES.find((candidate) => exists(candidate));
		if (modern) return { ...settings, shellPath: modern };
	}
	return settings;
}

/** True when the resolved shell is macOS's bash 3.2, so bash 4+ builtins must be avoided. */
export function usesLegacyMacBash(options: ShellOptions, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "darwin") return false;
	return options.shellPath === undefined || options.shellPath === "/bin/bash";
}

/** Tells the model up front which GNU habits fail here, so it does not learn them from errors. */
export function platformGuidance(options: ShellOptions, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "darwin") return "";
	const shell = usesLegacyMacBash(options, platform) ? " bash 3.2: no mapfile, readarray, or declare -A." : "";
	return `macOS BSD tools: sed -i '' (no \\U/\\L); no timeout command (use runInBackground + timeout); no grep -P (use -E); head -n needs a positive count; date -v, stat -f; no find -printf.${shell}`;
}

interface FailureHint {
	pattern: RegExp;
	hint: string;
}

const FAILURE_HINTS: FailureHint[] = [
	{
		pattern: /sed: \d+: [\s\S]*?(invalid command code|unterminated substitute|extra characters at the end)/,
		hint: "BSD sed -i takes a suffix argument: use sed -i '' 's/a/b/' file.",
	},
	{
		pattern: /\b(g?timeout): command not found/,
		hint: "macOS has no timeout command: drop it, or to cap the run time use runInBackground with timeout (the job is killed at the limit).",
	},
	{
		pattern: /grep: invalid option -- P/,
		hint: "BSD grep has no -P: use grep -E, or perl -ne 'print if /re/'.",
	},
	{
		pattern: /head: illegal (line|byte) count -- (0|-)/,
		hint: "BSD head rejects 0 and negative counts: use sed '$d' to drop the last line, or skip head entirely for zero lines.",
	},
	{
		pattern: /tail: illegal offset/,
		hint: "BSD tail accepts only -n N, -n +N, -c N, or -c +N with a plain number.",
	},
	{
		pattern: /\b(mapfile|readarray): command not found|declare: -A: invalid option/,
		hint: "This bash is 3.2: read lines with while IFS= read -r line; do ...; done, and avoid associative arrays.",
	},
	{
		pattern: /date: illegal option -- d/,
		hint: "BSD date has no -d: use date -v-1d for relative dates or date -j -f FORMAT VALUE to parse.",
	},
	{
		pattern: /stat: illegal option -- c/,
		hint: "BSD stat uses -f: for example stat -f %z FILE for the size.",
	},
	{
		pattern: /find: -printf: unknown primary/,
		hint: "BSD find has no -printf: use -print, or -exec stat -f FORMAT {} +.",
	},
];

/** Hints for BSD/GNU mismatches recognised in a failed command's output, in a stable order. */
export function failureHints(output: string): string[] {
	return FAILURE_HINTS.filter(({ pattern }) => pattern.test(output)).map(({ hint }) => hint);
}

/** Appends recognised hints to failed output on macOS; other platforms and unknown failures are returned unchanged. */
export function withFailureHints(output: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "darwin") return output;
	const hints = failureHints(output);
	if (hints.length === 0) return output;
	return `${output}\n\n[macOS hint] ${hints.join(" ")}`;
}
