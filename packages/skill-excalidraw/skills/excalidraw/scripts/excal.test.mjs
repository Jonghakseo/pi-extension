// Browser-free regression tests for excal.mjs. Commands that need the sync server
// (open with a window, snapshot) are covered by the manual smoke in references/setup.md.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(SCRIPTS_DIR, "excal.mjs");
const EXAMPLE = path.join(SCRIPTS_DIR, "..", "assets", "examples", "flowchart.excalidraw");

const run = (args, cwd) =>
	spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env } });

const withTempDir = (fn) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excal-test-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

test("bundled example passes the bundled linter", () => {
	const r = run(["lint", EXAMPLE]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /^OK$/m);
});

test("open --from-mermaid with a missing file fails without creating the diagram", () => {
	withTempDir((dir) => {
		const target = path.join(dir, "out.excalidraw");
		const r = run(["open", target, "--from-mermaid", path.join(dir, "nope.mmd")], dir);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /mermaid 파일이 없습니다/);
		assert.doesNotMatch(r.stderr, /at .*excal\.mjs/);
		assert.equal(fs.existsSync(target), false);
	});
});

test("inspect bounds cover text elements the window has not measured yet", () => {
	withTempDir((dir) => {
		const file = path.join(dir, "scene.excalidraw");
		fs.writeFileSync(
			file,
			JSON.stringify({
				type: "excalidraw",
				version: 2,
				elements: [
					{ type: "text", id: "title", x: 100, y: 20, text: "제목", fontSize: 28 },
					{ type: "rectangle", id: "box", x: 400, y: 200, width: 200, height: 72 },
				],
				appState: {},
				files: {},
			}),
		);
		const r = run(["inspect", file], dir);
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /범위 x 100~600, y 20~272/);
	});
});
