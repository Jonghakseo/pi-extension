import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { STATE_ROOT } from "./constants.js";
import type { SetupContext, StatePaths } from "./types.js";

export function statePaths(repoKey: string): StatePaths {
	const rootDir = STATE_ROOT;
	const locksDir = path.join(rootDir, "locks");
	const logsDir = path.join(rootDir, "logs");
	const statesDir = path.join(rootDir, "states");
	const exitsDir = path.join(rootDir, "exits");
	const wrappersDir = path.join(rootDir, "wrappers");
	return {
		rootDir,
		locksDir,
		logsDir,
		statesDir,
		exitsDir,
		wrappersDir,
		lockPath: path.join(locksDir, `${repoKey}.lock.json`),
		statePath: path.join(statesDir, `${repoKey}.json`),
	};
}

export function repoKeyFor(realRepoRoot: string): string {
	return createHash("sha256").update(realRepoRoot).digest("hex").slice(0, 16);
}

function fileHash(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function isExecutableOrReadable(filePath: string): boolean {
	try {
		statSync(filePath);
		return true;
	} catch {
		return false;
	}
}

export function findSetupPath(cwd: string): string | null {
	let current = path.resolve(cwd);
	try {
		current = realpathSync(current);
	} catch {
		// Keep resolved cwd when the directory cannot be canonicalized yet.
	}

	const candidate = path.join(current, "setup.sh");
	return isExecutableOrReadable(candidate) ? candidate : null;
}

export function resolveSetupContext(cwd: string): SetupContext | null {
	const setupPath = findSetupPath(cwd);
	if (!setupPath) return null;
	const realSetupPath = realpathSync(setupPath);
	const repoRoot = realpathSync(path.dirname(realSetupPath));
	const repoKey = repoKeyFor(repoRoot);
	return {
		repoRoot,
		setupPath: realSetupPath,
		repoKey,
		setupHash: fileHash(realSetupPath),
		paths: statePaths(repoKey),
	};
}

export function displayPath(targetPath: string): string {
	const home = os.homedir();
	if (targetPath === home) return "~";
	if (targetPath.startsWith(`${home}${path.sep}`)) return `~${targetPath.slice(home.length)}`;
	return targetPath;
}
