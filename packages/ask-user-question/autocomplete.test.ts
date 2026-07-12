import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFileAutocompleteProvider, fdBinaryNames, findAutocompleteBinary } from "./autocomplete.ts";

const originalPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = originalPath;
});

describe("ask-user-question/autocomplete", () => {
	it("@ 트리거 문자를 가진 프로바이더를 만든다", () => {
		const provider = createFileAutocompleteProvider(process.cwd());
		expect(provider.triggerCharacters).toEqual(["@"]);
		expect(typeof provider.getSuggestions).toBe("function");
	});

	it("플랫폼별 fd 바이너리 후보를 반환한다", () => {
		expect(fdBinaryNames("win32")).toEqual(["fd.exe", "fdfind.exe", "fd", "fdfind"]);
		expect(fdBinaryNames("darwin")).toEqual(["fd", "fdfind"]);
	});

	it("PATH가 비어 있으면 null을 반환한다", () => {
		process.env.PATH = "";
		expect(findAutocompleteBinary(["fd", "fdfind"])).toBeNull();
	});

	it("PATH에서 실행 가능한 바이너리를 찾는다", () => {
		const dir = mkdtempSync(join(tmpdir(), "ask-autocomplete-"));
		try {
			const binary = join(dir, "fake-fd");
			writeFileSync(binary, "#!/bin/sh\n");
			chmodSync(binary, 0o755);
			mkdirSync(join(dir, "empty"));
			process.env.PATH = [join(dir, "empty"), dir].join(delimiter);
			expect(findAutocompleteBinary(["missing-binary", "fake-fd"])).toBe(binary);
			expect(findAutocompleteBinary(["missing-binary"])).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
