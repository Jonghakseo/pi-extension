import { describe, expect, it } from "vitest";
import {
	buildTaskReport,
	buildWorkerInstructions,
	isRecursiveToolName,
	parseTaskReportDetails,
	parseWorkerControl,
	TASK_REPORT_TOOL,
} from "./protocol.js";

const report = { revision: 2, status: "success", summary: "Did the thing", verification: ["ran the tests"] };

describe("buildTaskReport", () => {
	it("normalizes optional lists and keeps the injected task id", () => {
		expect(buildTaskReport("task-1", report)).toEqual({
			taskId: "task-1",
			revision: 2,
			status: "success",
			summary: "Did the thing",
			artifacts: [],
			verification: ["ran the tests"],
			blockers: [],
		});
	});

	it("rejects a report that cannot be acted on", () => {
		expect(() => buildTaskReport("task-1", { ...report, revision: 0 })).toThrow(/revision/);
		expect(() => buildTaskReport("task-1", { ...report, status: "done" })).toThrow(/status/);
		expect(() => buildTaskReport("task-1", { ...report, summary: "  " })).toThrow(/summary/);
		expect(() => buildTaskReport("task-1", { ...report, blockers: [1] })).toThrow(/blockers/);
	});
});

describe("parseTaskReportDetails", () => {
	it("accepts only a well-formed report for this task", () => {
		const details = { taskReport: { ...report, taskId: "task-1" } };
		expect(parseTaskReportDetails(details, "task-1")?.revision).toBe(2);
		expect(parseTaskReportDetails(details, "task-2")).toBeUndefined();
	});

	it("ignores anything that is not a report", () => {
		expect(parseTaskReportDetails(undefined, "task-1")).toBeUndefined();
		expect(parseTaskReportDetails({ taskReport: "success" }, "task-1")).toBeUndefined();
		expect(parseTaskReportDetails({ status: "success" }, "task-1")).toBeUndefined();
		expect(parseTaskReportDetails({ taskReport: { taskId: "task-1", revision: 2 } }, "task-1")).toBeUndefined();
	});
});

describe("parseWorkerControl", () => {
	it("reads an activate message", () => {
		expect(parseWorkerControl(' {"op":"activate","revision":4} ')).toEqual({ op: "activate", revision: 4 });
	});

	it("refuses anything else the channel might receive", () => {
		expect(() => parseWorkerControl("not json")).toThrow(/JSON/);
		expect(() => parseWorkerControl('"activate"')).toThrow(/object/);
		expect(() => parseWorkerControl('{"op":"shutdown","revision":1}')).toThrow(/op/);
		expect(() => parseWorkerControl('{"op":"activate","revision":"2"}')).toThrow(/revision/);
	});
});

describe("isRecursiveToolName", () => {
	it("matches delegation tools regardless of case", () => {
		expect(isRecursiveToolName("Task")).toBe(true);
		expect(isRecursiveToolName(" subagent ")).toBe(true);
	});

	it("leaves the worker's own tools alone", () => {
		expect(isRecursiveToolName(TASK_REPORT_TOOL)).toBe(false);
		expect(isRecursiveToolName("task_context")).toBe(false);
		expect(isRecursiveToolName("bash_async")).toBe(false);
	});
});

describe("buildWorkerInstructions", () => {
	it("names the active revision and the report protocol", () => {
		const text = buildWorkerInstructions({ taskId: "task-1", revision: 7, readonly: false });
		expect(text).toContain("revision is 7");
		expect(text).toContain(TASK_REPORT_TOOL);
		expect(text).toContain("Background jobs");
		expect(text).not.toContain("readonly:");
	});

	it("adds the readonly instruction only when the Task is readonly", () => {
		expect(buildWorkerInstructions({ taskId: "task-1", revision: 1, readonly: true })).toContain("not a sandbox");
	});
});
