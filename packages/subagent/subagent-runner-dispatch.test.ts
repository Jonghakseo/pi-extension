import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

describe("runSingleAgent dispatch", () => {
	beforeEach(() => {
		spawnMock.mockReset();
		vi.resetModules();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("rejects discovery-time configuration errors before spawning", async () => {
		const { runSingleAgent } = await import("./runner.ts");
		const agents = [
			{
				name: "invalid-config",
				description: "Invalid config",
				configurationError: '/tmp/invalid.md: runtime "claude" is no longer supported.',
				systemPrompt: "test",
				source: "user" as const,
				filePath: "/tmp/invalid.md",
			},
		];

		const result = await runSingleAgent(
			"/tmp",
			agents,
			"invalid-config",
			"do something",
			undefined,
			undefined,
			undefined,
			(results) => ({ mode: "single", inheritMainContext: false, projectAgentsDir: null, results }),
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Invalid agent configuration");
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("returns unknown agent error for non-existent agent", async () => {
		const { runSingleAgent } = await import("./runner.ts");

		const result = await runSingleAgent(
			"/tmp",
			[],
			"nonexistent",
			"do something",
			undefined,
			undefined,
			undefined,
			(results) => ({
				mode: "single",
				inheritMainContext: false,
				projectAgentsDir: null,
				results,
			}),
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Unknown agent");
	});
});
