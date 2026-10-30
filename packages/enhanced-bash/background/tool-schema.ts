import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export const DEFAULT_TIMEOUT_SECONDS = 3_600;
export const MAX_OUTPUT_LINES = 200;

/** Formats the sync window the way both the tool description and start results state it. */
export function formatSyncWindow(windowMs: number): string {
	// Only whole seconds become "Ns"; rounding 1500 ms to "2s" would state a window that is never waited.
	return windowMs >= 1_000 && windowMs % 1_000 === 0 ? `${windowMs / 1_000}s` : `${windowMs}ms`;
}

export type CwdValidationResult = { ok: true; cwd: string } | { ok: false; error: string };

/** Resolves against the current tool cwd and follows symlinks before accepting a job. */
export async function validateCwd(cwd: string | undefined, contextCwd: string): Promise<CwdValidationResult> {
	const resolvedCwd = resolve(contextCwd, cwd ?? ".");
	try {
		const stats = await stat(resolvedCwd);
		if (!stats.isDirectory()) return { ok: false, error: `cwd is not a directory: ${resolvedCwd}` };
		return { ok: true, cwd: resolvedCwd };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `cwd does not exist or cannot be accessed: ${resolvedCwd} (${reason})` };
	}
}
