import { describe, expect, it } from "vitest";
import { normalizeQueryList } from "./index.js";

describe("web-access index helpers", () => {
	it("normalizes query lists by trimming strings and dropping empty or non-string values", () => {
		expect(normalizeQueryList(["  a  ", "", 42, null, "b"])).toEqual(["a", "b"]);
		expect(normalizeQueryList([])).toEqual([]);
	});
});
