import { afterEach, describe, expect, it, vi } from "vitest";
import memoryLayerExtension from "./index.ts";

describe("memory layer extension registration", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers slash commands synchronously for initial autocomplete", () => {
		vi.useFakeTimers();
		const registerCommand = vi.fn();
		const on = vi.fn();

		memoryLayerExtension({ registerCommand, on } as never);

		expect(registerCommand.mock.calls.map(([name]) => name)).toEqual(["remember", "memory"]);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});
});
