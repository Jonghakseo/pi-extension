import { describe, expect, it } from "vitest";
import {
	type MemoryToolDetails,
	renderForgetCall,
	renderForgetResult,
	renderMemoryListCall,
	renderMemoryListResult,
	renderRecallCall,
	renderRecallResult,
	renderRememberCall,
	renderRememberResult,
} from "./tool-render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const ansiColorPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function render(component: { render(width: number): string[] }): string {
	return component
		.render(240)
		.map((line) => line.replace(ansiColorPattern, "").trimEnd())
		.join("\n");
}

function result(text: string, details: MemoryToolDetails) {
	return { content: [{ type: "text", text }], details };
}

describe("memory-layer compact tool rendering", () => {
	it("summarizes remember only when collapsed", () => {
		const args = { scope: "project", topic: "general", title: "배포 규칙", content: "full memory content" };
		const fullResult = "Memory saved.\nScope: project\nTopic: general.md\nTitle: 배포 규칙";
		const details = { kind: "remember", scope: "project", topic: "general", title: "배포 규칙" } as const;

		expect(render(renderRememberCall(args, theme as never, { expanded: false }))).toBe(
			'remember · project/general · "배포 규칙"',
		);
		expect(render(renderRememberResult(result(fullResult, details), { expanded: false }, theme as never))).toBe(
			"✓ saved",
		);
		expect(render(renderRememberCall(args, theme as never, { expanded: true }))).toBe("remember");
		expect(render(renderRememberResult(result(fullResult, details), { expanded: true }, theme as never))).toBe(
			fullResult,
		);
	});

	it("summarizes recall query matches only when collapsed", () => {
		const args = { query: "npm publish", scope: "user" };
		const fullResult = "Found 3 memories:\n\n- [abc] [user] general/npm login 선행\n  full snippet";
		const details = {
			kind: "recall-query",
			total: 3,
			matches: [
				{ scope: "user", topic: "general", title: "npm login 선행" },
				{ scope: "user", topic: "general", title: "OTP 처리" },
			],
		} as const;

		expect(render(renderRecallCall(args, theme as never, { expanded: false }))).toBe('recall · "npm publish" · user');
		expect(render(renderRecallResult(result(fullResult, details), { expanded: false }, theme as never))).toBe(
			"✓ 3 matches · npm login 선행, OTP 처리, +1",
		);
		expect(render(renderRecallCall(args, theme as never, { expanded: true }))).toBe('recall "npm publish" scope:user');
		expect(render(renderRecallResult(result(fullResult, details), { expanded: true }, theme as never))).toBe(
			fullResult,
		);
	});

	it("summarizes recall id and index modes", () => {
		const idDetails = { kind: "recall-id", scope: "project", topic: "general", title: "배포 절차" } as const;
		const indexDetails = {
			kind: "recall-index",
			user: 23,
			project: 4,
			topics: 5,
		} as const;

		expect(render(renderRecallCall({ id: "57cf723214aa" }, theme as never, { expanded: false }))).toBe(
			"recall · id:57cf7...",
		);
		expect(render(renderRecallResult(result("full content", idDetails), { expanded: false }, theme as never))).toBe(
			"✓ project/general · 배포 절차",
		);
		expect(render(renderRecallCall({}, theme as never, { expanded: false }))).toBe("recall · index · all");
		expect(render(renderRecallResult(result("full index", indexDetails), { expanded: false }, theme as never))).toBe(
			"✓ 27 memories · user 23 / project 4",
		);
	});

	it("keeps the resolved forget target visible when scope or topic was inferred", () => {
		const details = { kind: "forget", scope: "user", topic: "general", title: "배포 규칙" } as const;
		const fullResult = 'Deleted from user: general / "배포 규칙"';

		expect(render(renderForgetCall({ title: "배포 규칙" }, theme as never, { expanded: false }))).toBe(
			'forget · auto · "배포 규칙"',
		);
		expect(
			render(renderForgetResult(result(fullResult, details), { expanded: false }, theme as never, { args: {} })),
		).toBe("✓ deleted · user/general");
		expect(
			render(
				renderForgetResult(result(fullResult, details), { expanded: false }, theme as never, {
					args: { scope: "user", topic: "general" },
				}),
			),
		).toBe("✓ deleted");
		expect(
			render(renderForgetResult(result(fullResult, details), { expanded: true }, theme as never, { args: {} })),
		).toBe(fullResult);
	});

	it("summarizes memory list counts only when collapsed", () => {
		const details = { kind: "memory-list", scope: "project", user: 0, project: 4, topics: 1 } as const;
		const fullResult = "[Project Memory]\n# Memory Index\n...";

		expect(render(renderMemoryListCall({ scope: "project" }, theme as never, { expanded: false }))).toBe(
			"memory_list · project",
		);
		expect(render(renderMemoryListResult(result(fullResult, details), { expanded: false }, theme as never))).toBe(
			"✓ 4 memories · 1 topic",
		);
		expect(render(renderMemoryListCall({ scope: "project" }, theme as never, { expanded: true }))).toBe("memory_list");
		expect(render(renderMemoryListResult(result(fullResult, details), { expanded: true }, theme as never))).toBe(
			fullResult,
		);
	});
});
