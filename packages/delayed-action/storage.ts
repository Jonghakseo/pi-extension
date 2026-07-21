import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Allow tests/power users to relocate the store; resolved lazily so env changes take effect.
function defaultStoreDir(): string {
	return process.env.PI_DELAYED_ACTION_DIR || path.join(os.homedir(), ".pi", "delayed-action");
}

const STORE_VERSION = 1;

export interface PersistedTask {
	id: string;
	prompt: string;
	createdAt: number;
	dueAt: number;
}

interface StoreFile {
	version: number;
	sessionId: string;
	tasks: PersistedTask[];
}

function sanitizeSessionId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^\.+/, "");
	if (!safe) throw new Error(`Invalid session id for delay persistence: ${sessionId}`);
	return safe;
}

function storePath(sessionId: string, dir: string): string {
	return path.join(dir, `${sanitizeSessionId(sessionId)}.json`);
}

function isValidTask(value: unknown): value is PersistedTask {
	if (!value || typeof value !== "object") return false;
	const task = value as Record<string, unknown>;
	return (
		typeof task.id === "string" &&
		task.id.length > 0 &&
		typeof task.prompt === "string" &&
		typeof task.createdAt === "number" &&
		Number.isFinite(task.createdAt) &&
		typeof task.dueAt === "number" &&
		Number.isFinite(task.dueAt)
	);
}

export async function loadPersistedTasks(sessionId: string, dir = defaultStoreDir()): Promise<PersistedTask[]> {
	try {
		const raw = await readFile(storePath(sessionId, dir), "utf8");
		const parsed = JSON.parse(raw) as Partial<StoreFile>;
		if (!parsed || !Array.isArray(parsed.tasks)) return [];
		return parsed.tasks.filter(isValidTask);
	} catch {
		// Missing or corrupted store: start empty rather than throwing.
		return [];
	}
}

export async function savePersistedTasks(
	sessionId: string,
	tasks: PersistedTask[],
	dir = defaultStoreDir(),
): Promise<void> {
	const target = storePath(sessionId, dir);
	if (tasks.length === 0) {
		await unlink(target).catch(() => {});
		return;
	}
	await mkdir(dir, { recursive: true });
	const payload: StoreFile = {
		version: STORE_VERSION,
		sessionId,
		tasks: tasks.map(({ id, prompt, createdAt, dueAt }) => ({ id, prompt, createdAt, dueAt })),
	};
	const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
	await rename(tmp, target);
}
