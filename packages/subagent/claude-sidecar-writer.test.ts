/** biome-ignore-all lint/suspicious/noExplicitAny: tests use lightweight runtime-shaped fixtures and mocks. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSidecarWriter } from "./claude-sidecar-writer.ts";
import { readSessionReplayItems } from "./replay.ts";

let tmpDir: string;
let sidecarFile: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-test-"));
	sidecarFile = path.join(tmpDir, "test-session.jsonl");
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true });
	} catch {
		/* ignore */
	}
});

function makeStreamState(messages: any[] = []) {
	return {
		sessionId: undefined,
		model: undefined,
		messages,
		liveText: undefined,
		liveThinking: undefined,
		liveToolCalls: 0,
		thoughtText: undefined,
		stopReason: undefined,
		errorMessage: undefined,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		resultReceived: false,
		resultEvent: undefined,
		isError: false,
		permissionDenials: [],
		liveActivityPreview: undefined,
		currentToolName: undefined,
		currentToolInput: "",
	};
}

describe("claude-sidecar-writer", () => {
	it("writes user message as first entry", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const items = readSessionReplayItems(sidecarFile);
		expect(items).toHaveLength(1);
		expect(items[0].type).toBe("user");
		expect(items[0].content).toContain("Do the task");
	});

	it("writes assistant turn with text content", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const state = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Here is my answer." }] }]);
		writer.writeAssistantTurn(state);

		const items = readSessionReplayItems(sidecarFile);
		expect(items).toHaveLength(2);
		expect(items[1].type).toBe("assistant");
		expect(items[1].content).toContain("Here is my answer.");
	});

	it("writes assistant turn with toolCall parts", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const state = makeStreamState([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "toolCall", name: "Read", arguments: { file_path: "/tmp/x.ts" } },
				],
			},
		]);
		writer.writeAssistantTurn(state);

		const items = readSessionReplayItems(sidecarFile);
		expect(items).toHaveLength(2);
		expect(items[1].type).toBe("assistant");
		expect(items[1].content).toContain("Let me check.");
		expect(items[1].content).toContain("Read");
	});

	it("writes toolResult entries", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");
		writer.writeToolResult("Read", "file contents here");

		const items = readSessionReplayItems(sidecarFile);
		expect(items).toHaveLength(2);
		expect(items[1].type).toBe("tool");
		expect(items[1].title).toBe("Tool: Read");
		expect(items[1].content).toContain("file contents here");
	});

	it("preserves full toolResult content without truncation", () => {
		const writer = createSidecarWriter(sidecarFile);
		const longContent = "A".repeat(1200);

		writer.writeUserMessage("Do the task");
		writer.writeToolResult("Read", longContent);

		const items = readSessionReplayItems(sidecarFile);
		expect(items).toHaveLength(2);
		expect(items[1].content).toContain(longContent);
		expect(items[1].content).not.toContain("...");
	});

	it("prevents duplicate assistant turns", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const state = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Answer 1" }] }]);

		writer.writeAssistantTurn(state);
		writer.writeAssistantTurn(state);
		writer.writeAssistantTurn(state);

		const items = readSessionReplayItems(sidecarFile);
		const assistantItems = items.filter((i) => i.type === "assistant");
		expect(assistantItems).toHaveLength(1);
	});

	it("allows new assistant turn after message count increases", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const state = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Answer 1" }] }]);
		writer.writeAssistantTurn(state);

		state.messages.push({ role: "user", content: [{ type: "text", text: "tool result" }] });
		state.messages.push({ role: "assistant", content: [{ type: "text", text: "Answer 2" }] });
		writer.writeAssistantTurn(state);

		const items = readSessionReplayItems(sidecarFile);
		const assistantItems = items.filter((i) => i.type === "assistant");
		expect(assistantItems).toHaveLength(2);
	});

	it("supports continue by appending to same file", () => {
		const writer1 = createSidecarWriter(sidecarFile);
		writer1.writeUserMessage("First task");
		const state1 = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Done first" }] }]);
		writer1.writeAssistantTurn(state1);

		const writer2 = createSidecarWriter(sidecarFile);
		writer2.writeUserMessage("Continue task");
		const state2 = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Done continue" }] }]);
		writer2.writeAssistantTurn(state2);

		const items = readSessionReplayItems(sidecarFile);
		expect(items).toHaveLength(4);
		expect(items[0].type).toBe("user");
		expect(items[0].content).toContain("First task");
		expect(items[1].type).toBe("assistant");
		expect(items[2].type).toBe("user");
		expect(items[2].content).toContain("Continue task");
		expect(items[3].type).toBe("assistant");
	});

	it("writes thinking as preview/summary", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const longThinking = "A".repeat(300);
		const state = makeStreamState([
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: longThinking },
					{ type: "text", text: "Final answer" },
				],
			},
		]);
		writer.writeAssistantTurn(state);

		const raw = fs.readFileSync(sidecarFile, "utf-8");
		const lines = raw.trim().split("\n");
		const assistantEntry = JSON.parse(lines[1]);
		const thinkingPart = assistantEntry.message.content.find((p: any) => p.type === "thinking");
		expect(thinkingPart.thinking.length).toBeLessThan(longThinking.length);
		expect(thinkingPart.thinking).toContain("...");
	});

	it("writeFinalAssistant does not duplicate last turn", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const state = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Answer" }] }]);
		writer.writeAssistantTurn(state);
		writer.writeFinalAssistant(state);

		const items = readSessionReplayItems(sidecarFile);
		const assistantItems = items.filter((i) => i.type === "assistant");
		expect(assistantItems).toHaveLength(1);
	});

	it("writeFinalAssistant writes if turn was not yet written", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Do the task");

		const state = makeStreamState([{ role: "assistant", content: [{ type: "text", text: "Answer" }] }]);
		writer.writeFinalAssistant(state);

		const items = readSessionReplayItems(sidecarFile);
		const assistantItems = items.filter((i) => i.type === "assistant");
		expect(assistantItems).toHaveLength(1);
	});
});

describe("claude-sidecar-writer: parseSessionDetailSummary compatibility", () => {
	it("produces correct turn count and final output", () => {
		const writer = createSidecarWriter(sidecarFile);
		writer.writeUserMessage("Build the feature");

		const state = makeStreamState([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Let me read the file." },
					{ type: "toolCall", name: "Read", arguments: { file_path: "/tmp/x.ts" } },
				],
			},
		]);
		writer.writeAssistantTurn(state);
		writer.writeToolResult("Read", "file contents");

		state.messages.push({ role: "user", content: [{ type: "text", text: "file contents" }] });
		state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "Here is the final answer." }],
		});
		writer.writeAssistantTurn(state);

		const raw = fs.readFileSync(sidecarFile, "utf-8");
		const assistantMessages: any[] = [];
		const turns: any[] = [];

		for (const line of raw.split(/\r?\n/)) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			if (entry?.type !== "message" || !entry.message || entry.message.role !== "assistant") continue;
			assistantMessages.push(entry.message);
			const turn = assistantMessages.length;
			const toolCalls: any[] = [];
			if (Array.isArray(entry.message.content)) {
				for (const part of entry.message.content) {
					if (part?.type === "toolCall") {
						toolCalls.push({ name: part.name ?? "tool" });
					}
				}
			}
			if (toolCalls.length > 0) turns.push({ turn, toolCalls });
		}

		expect(assistantMessages).toHaveLength(2);
		expect(turns).toHaveLength(1);
		expect(turns[0].toolCalls[0].name).toBe("Read");

		const lastText = assistantMessages[assistantMessages.length - 1].content
			.filter((p: any) => p.type === "text")
			.map((p: any) => p.text)
			.join("");
		expect(lastText).toBe("Here is the final answer.");
	});
});

describe("claude-sidecar-writer: full round-trip with readSessionReplayItems", () => {
	it("produces correct replay structure for multi-turn conversation", () => {
		const writer = createSidecarWriter(sidecarFile);

		writer.writeUserMessage("Implement the feature");

		const state = makeStreamState([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "I will read the file first." },
					{ type: "toolCall", name: "Read", arguments: { file_path: "/src/app.ts" } },
				],
			},
		]);
		writer.writeAssistantTurn(state);

		writer.writeToolResult("Read", "export function main() {}");

		state.messages.push({ role: "user", content: [{ type: "text", text: "export function main() {}" }] });
		state.messages.push({
			role: "assistant",
			content: [
				{ type: "text", text: "Now I will edit it." },
				{ type: "toolCall", name: "Edit", arguments: { file_path: "/src/app.ts" } },
			],
		});
		writer.writeAssistantTurn(state);

		writer.writeToolResult("Edit", "File edited successfully");

		state.messages.push({ role: "user", content: [{ type: "text", text: "File edited successfully" }] });
		state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "Done! The feature has been implemented." }],
		});
		writer.writeFinalAssistant(state);

		const items = readSessionReplayItems(sidecarFile);

		expect(items).toHaveLength(6);
		expect(items[0]).toMatchObject({ type: "user", title: "User" });
		expect(items[1]).toMatchObject({ type: "assistant", title: "Assistant" });
		expect(items[2]).toMatchObject({ type: "tool", title: "Tool: Read" });
		expect(items[3]).toMatchObject({ type: "assistant", title: "Assistant" });
		expect(items[4]).toMatchObject({ type: "tool", title: "Tool: Edit" });
		expect(items[5]).toMatchObject({ type: "assistant", title: "Assistant" });
		expect(items[5].content).toContain("Done! The feature has been implemented.");
	});
});
