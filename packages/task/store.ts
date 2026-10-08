import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TaskContextSnapshot, TaskRecord, TaskStatus } from "./types.js";

const STATUSES = new Set<TaskStatus>([
	"queued",
	"evaluating",
	"running",
	"waiting",
	"completed",
	"failed",
	"blocked",
	"interrupted",
]);
export const isActive = (status: TaskStatus): boolean =>
	status === "queued" || status === "evaluating" || status === "running" || status === "waiting";

export function writePrivateJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporary, file);
}

export class TaskStore {
	readonly directory: string;
	private readonly file: string;

	constructor(
		root: string,
		readonly parentSessionId: string,
	) {
		const key = createHash("sha256").update(parentSessionId).digest("hex");
		this.directory = path.join(root, key);
		this.file = path.join(this.directory, "tasks.json");
	}

	load(): TaskRecord[] {
		if (!existsSync(this.file)) return [];
		const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
		if (!Array.isArray(value)) throw new Error(`Invalid Task state: ${this.file}`);
		return value.map((item: unknown) => {
			if (!item || typeof item !== "object") throw new Error(`Invalid Task record: ${this.file}`);
			const record = item as TaskRecord;
			if (
				typeof record.id !== "string" ||
				!/^task-[a-f0-9-]+$/.test(record.id) ||
				record.parentSessionId !== this.parentSessionId ||
				!Number.isSafeInteger(record.revision) ||
				record.revision < 1 ||
				!STATUSES.has(record.status) ||
				!Array.isArray(record.instructions) ||
				!record.instructions.every((instruction) => typeof instruction === "string") ||
				typeof record.cwd !== "string" ||
				typeof record.readonly !== "boolean"
			)
				throw new Error(`Invalid Task record: ${this.file}`);
			const files = this.paths(record.id);
			// Runtime paths are derived locally, not trusted from a persisted file.
			return { ...record, ...files };
		});
	}

	paths(id: string): { sessionFile: string; contextFile: string } {
		if (!/^task-[a-f0-9-]+$/.test(id)) throw new Error("Invalid Task ID");
		return {
			sessionFile: path.join(this.directory, id, "session.jsonl"),
			contextFile: path.join(this.directory, id, "context.json"),
		};
	}

	save(records: Iterable<TaskRecord>): void {
		writePrivateJson(this.file, [...records]);
	}

	writeContext(id: string, snapshot: TaskContextSnapshot): void {
		writePrivateJson(this.paths(id).contextFile, snapshot);
	}

	readContext(id: string): TaskContextSnapshot {
		const value: unknown = JSON.parse(readFileSync(this.paths(id).contextFile, "utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			!("brief" in value) ||
			typeof value.brief !== "string" ||
			!("entries" in value) ||
			!Array.isArray(value.entries)
		)
			throw new Error("Invalid Task context snapshot");
		return value as TaskContextSnapshot;
	}
}
