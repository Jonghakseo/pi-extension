import { describe, expect, it } from "vitest";
import { RECALL_NOTE, TUI_SAFE_LINE_CHARS, wrapLongLines } from "../src/core/format.ts";
import { type CompactionState, compileRanked, compileRankedWithState } from "../src/core/summarize.ts";
import { parseFileActivitySection } from "../src/extract/files.ts";
import { assistantText, assistantWithToolCall, userMsg } from "./fixtures.ts";

// The wrapper earlier summaries were written with: it could split AT a space
// exactly at the width, producing a full-width line that was not a mid-token cut.
const legacyWrapLine = (line: string, maxChars = 120): string[] => {
	if (line.length <= maxChars) return [line];
	const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
	const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
	const wrapped: string[] = [];
	let remaining = line;
	let prefix = "";
	while (prefix.length + remaining.length > maxChars) {
		const available = Math.max(20, maxChars - prefix.length);
		let splitAt = remaining.lastIndexOf(" ", available);
		if (splitAt < Math.floor(available * 0.5)) splitAt = available;
		wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
		remaining = remaining.slice(splitAt).trimStart();
		prefix = continuationIndent;
	}
	if (remaining) wrapped.push(prefix + remaining);
	return wrapped;
};
const legacyWrap = (text: string): string =>
	text
		.split("\n")
		.flatMap((l) => legacyWrapLine(l))
		.join("\n");

const LEGACY_NOTE =
	"Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.";

const countNotes = (s: string) =>
	s.split("to recover details from before this summary").length - 1 + (s.split("to search for prior work").length - 1);

const filesSection = (s: string) => s.match(/\[Files And Changes\]\n([\s\S]*?)(?=\n\n|$)/)?.[1] ?? "";

const editWindow = (label: string, paths: string[]) => [
	userMsg(`${label} 작업을 수정해줘`),
	...paths.map((p) => assistantWithToolCall("edit", { path: p, edits: [{ oldText: "a", newText: "b" }] })),
	assistantText(`${label} 완료`),
];

describe("merging with the previous summary", () => {
	it("keeps the recall note within the TUI line width so it is never wrapped", () => {
		expect(RECALL_NOTE.length).toBeLessThanOrEqual(TUI_SAFE_LINE_CHARS);
		expect(wrapLongLines(RECALL_NOTE)).toBe(RECALL_NOTE);
	});

	it("leaves exactly one recall note, removing wrapped legacy notes embedded mid-brief", () => {
		const legacy = wrapLongLines(
			`[Session Goal]\n- 기존 목표\n\n---\n\n[user]\n옛 요청\n\n---\n\n${LEGACY_NOTE}\n\n[assistant]\n옛 답변\n\n---\n\n${LEGACY_NOTE}`,
		);
		let summary = compileRanked({ messages: editWindow("첫", ["/repo/a.ts"]), previousSummary: legacy });
		for (let i = 0; i < 3; i++) {
			summary = compileRanked({ messages: editWindow(`반복 ${i}`, [`/repo/r${i}.ts`]), previousSummary: summary });
		}
		expect(countNotes(summary)).toBe(1);
		expect(summary).not.toContain("to search for prior work");
		expect(summary.trimEnd().endsWith(RECALL_NOTE)).toBe(true);
		// The legacy brief content itself survives the cleanup.
		expect(summary).toContain("옛 답변");
	});

	it("accumulates modified files across compactions, showing the newest and counting the rest", () => {
		let state: CompactionState | undefined;
		let summary = "";
		for (let w = 0; w < 4; w++) {
			const paths = Array.from({ length: 5 }, (_, i) => `/repo/src/w${w}/file-${i}.ts`);
			const out = compileRankedWithState({
				messages: editWindow(`창 ${w}`, paths),
				previousSummary: summary || undefined,
				previousState: state,
				pathDisplay: { root: "/repo" },
			});
			state = out.state;
			summary = out.summary;
		}
		expect(state?.files.modified).toHaveLength(20);
		const files = filesSection(summary).replace(/\n\s+/g, " ");
		expect(files).toContain("src/w3/file-4.ts");
		expect(files).toContain("src/w2/file-0.ts");
		expect(files).not.toContain("src/w0/file-0.ts");
		expect(files).toContain("(+10 earlier)");
	});

	it("recovers every file of a wrapped legacy [Files And Changes] section when no state exists", () => {
		const legacyPaths = Array.from({ length: 8 }, (_, i) => `module-${i}/component-file-${i}.ts`);
		const legacy = wrapLongLines(
			`[Files And Changes]\n- Modified: ${legacyPaths.join(", ")}\n\n---\n\n[user]\n옛 요청\n\n---\n\n${LEGACY_NOTE}`,
		);
		expect(legacy.split("\n").filter((l) => l.startsWith("  ")).length).toBeGreaterThan(0);
		const { state } = compileRankedWithState({
			messages: editWindow("새", ["/repo/new.ts"]),
			previousSummary: legacy,
		});
		for (const p of legacyPaths) expect(state.files.modified).toContain(p);
		expect(state.files.modified.at(-1)).toBe("/repo/new.ts");
	});

	it("merges a legacy trimmed path with the same file seen again as an absolute path", () => {
		const legacy = "[Files And Changes]\n- Modified: src/auth.ts, src/other.ts\n\n---\n\n[user]\n옛 요청";
		const { state } = compileRankedWithState({
			messages: editWindow("재수정", ["/repo/src/auth.ts"]),
			previousSummary: legacy,
		});
		expect(state.files.modified).toEqual(["src/other.ts", "/repo/src/auth.ts"]);
	});

	it("keeps the brief of a previous summary that had no header sections", () => {
		const previousSummary = `[user]\n헤더 없는 옛 요청\n\n[assistant]\n헤더 없는 옛 답변\n\n---\n\n${RECALL_NOTE}`;
		const summary = compileRanked({ messages: editWindow("새", ["/repo/x.ts"]), previousSummary });
		expect(summary).toContain("헤더 없는 옛 답변");
	});

	it("keeps two list items apart when a legacy wrap filled the line exactly at a comma", () => {
		// Before the space-split fix a split AT a space could fill the width, so a
		// full-width line does not always mean a mid-token cut.
		const first = `Picky/HUD/${"Conversation/".repeat(6)}CardView.swift`.padStart(107, "x");
		const second = "Picky/HUD/Conversation/PickyConversationComposerView.swift";
		const section = legacyWrap(`[Files And Changes]\n- Modified: ${first}, ${second}`);
		const physical = section.split("\n");
		expect(physical[1]).toHaveLength(120);
		expect(physical[1].endsWith(",")).toBe(true);
		expect(parseFileActivitySection(section)?.modified).toEqual([first, second]);
	});

	it("recovers every path of wrapped file lists, with legacy and current wrapping", () => {
		let seed = 20260928;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789-_.";
		const word = () =>
			Array.from({ length: 2 + Math.floor(rand() * 18) }, () => chars[Math.floor(rand() * chars.length)]).join("");
		const path = () => Array.from({ length: 1 + Math.floor(rand() * 5) }, word).join("/");
		for (let n = 0; n < 300; n++) {
			const list = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 20) }, path))];
			const suffix = rand() < 0.3 ? ` (+${1 + Math.floor(rand() * 90)} earlier)` : "";
			const section = `[Files And Changes]\n- Read: ${list.join(", ")}${suffix}`;
			for (const wrap of [wrapLongLines, legacyWrap]) {
				expect(parseFileActivitySection(wrap(section))?.read).toEqual(list);
			}
		}
	});

	it.each([
		[
			"a pi-vcc-ko summary",
			"[Session Goal]\n- 옛 목표\n\n---\n\n[user]\n옛 요청\n\n[assistant]\n옛 작업의 마지막 결론",
		],
		["a foreign summary without our headers", "## Goal\n옛 목표\n\n## Progress\n- 옛 작업의 마지막 결론"],
	])("keeps the tail of %s even when the fresh brief alone exceeds the line budget", (_, previousSummary) => {
		const messages = Array.from({ length: 30 }, (_, i) => [
			userMsg(`새 요청 ${i}번을 처리해줘`),
			assistantText(`새 요청 ${i}번 처리 완료`),
		]).flat();
		const summary = compileRanked({ messages, previousSummary, ranking: { maxBlocks: 500, preserveRecentBlocks: 0 } });
		expect(summary.split("\n").length).toBeGreaterThan(150);
		expect(summary).toContain("옛 작업의 마지막 결론");
	});

	it("renders paths below cwd relative, below home with ~/, and others absolute", () => {
		const { summary } = compileRankedWithState({
			messages: editWindow("경로", ["/work/proj/src/a.ts", "/home/me/.config/tool.json", "/tmp/scratch.txt"]),
			pathDisplay: { root: "/work/proj", home: "/home/me" },
		});
		const files = filesSection(summary);
		expect(files).toContain("src/a.ts");
		expect(files).not.toContain("/work/proj/src/a.ts");
		expect(files).toContain("~/.config/tool.json");
		expect(files).toContain("/tmp/scratch.txt");
	});
});
