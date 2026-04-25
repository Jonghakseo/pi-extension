import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyTodoWrite,
	buildPostCompactionTodoReminder,
	getTodoOverlayVisibility,
	parseTodoOverlayCommand,
	renderTodoOverlayPlainLines,
	renderTodoWriteSummary,
	restoreTodoWriteState,
} from "./index.ts";

describe("todo-write-overlay helpers", () => {
	it("parses todo overlay command actions", () => {
		expect(parseTodoOverlayCommand("")).toBe("status");
		expect(parseTodoOverlayCommand(" show ")).toBe("show");
		expect(parseTodoOverlayCommand("HIDE")).toBe("hide");
		expect(parseTodoOverlayCommand("toggle")).toBe("invalid");
	});

	it("normalizes multiple in-progress tasks", () => {
		const applied = applyTodoWrite([
			{ content: "first", status: "in_progress" },
			{ content: "second", status: "in_progress" },
			{ content: "third", status: "pending" },
		]);

		expect(applied.state.tasks.map((task) => task.status)).toEqual(["in_progress", "pending", "pending"]);
	});

	it("renders overlay plain lines without completed-item folding", () => {
		const applied = applyTodoWrite([
			{ content: "A", status: "completed" },
			{ content: "B", status: "completed" },
			{ content: "C", status: "completed", notes: "kept visible" },
		]);

		expect(renderTodoOverlayPlainLines(applied.state)).toEqual(["✓ A", "✓ B", "✓ C"]);
		expect(renderTodoWriteSummary(applied.state)).toContain("진행률: 3/3 완료");
	});

	it("uses activeForm for the active overlay line", () => {
		const applied = applyTodoWrite([
			{ content: "Design", status: "completed" },
			{ content: "Implement", status: "in_progress", activeForm: "Implementing" },
			{ content: "Verify", status: "pending" },
		]);

		expect(renderTodoOverlayPlainLines(applied.state)).toEqual(["✓ Design", "→ Implementing", "○ Verify"]);
	});

	it("hides fully completed overlays after the grace period", () => {
		const applied = applyTodoWrite([{ content: "Done", status: "completed" }]);
		const now = Date.now();
		expect(getTodoOverlayVisibility(applied.state, { completedAt: now, completedTurn: 1 }, 1, now)).toMatchObject({
			hidden: false,
			completionGraceActive: true,
		});
		expect(
			getTodoOverlayVisibility(applied.state, { completedAt: now - 91_000, completedTurn: 1 }, 3, now),
		).toMatchObject({ hidden: true, completionGraceActive: false });
	});

	it("restores legacy persisted tasks and builds post-compaction reminders", () => {
		const ctx = {
			cwd: "/tmp/project",
			sessionManager: {
				getSessionFile: () => "/tmp/project/session.json",
				getBranch: () => [
					{
						type: "custom",
						customType: "todo-write-overlay-state",
						data: {
							tasks: [
								{ id: "task-1", content: "cleanup", status: "abandoned" },
								{ id: "task-2", content: "ship", status: "pending" },
							],
							updatedAt: Date.now(),
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		const restored = restoreTodoWriteState(ctx);
		expect(restored.tasks.map((task) => task.status)).toEqual(["completed", "in_progress"]);
		expect(buildPostCompactionTodoReminder(restored)).toContain("todo_write에 아직 남은 항목이 있습니다");
	});
});
