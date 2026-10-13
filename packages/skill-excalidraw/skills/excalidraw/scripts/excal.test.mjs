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

// ---------- library ----------

const runIn = (stateDir, args, extraEnv = {}) =>
	spawnSync(process.execPath, [CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, EXCAL_STATE_DIR: stateDir, EXCAL_BROWSER: "none", ...extraEnv },
	});

const rect = (id, x, y, extra = {}) => ({
	type: "rectangle",
	id,
	version: 1,
	x,
	y,
	width: 100,
	height: 60,
	groupIds: [],
	...extra,
});

/** v1 library (bare element arrays, no names) and v2 library (named items with a bound label). */
function writeLibraries(dir) {
	const v1 = path.join(dir, "shapes.excalidrawlib");
	fs.writeFileSync(
		v1,
		JSON.stringify({
			type: "excalidrawlib",
			version: 1,
			library: [[rect("a", 0, 0)], [rect("b", 0, 0, { width: 40 })]],
		}),
	);
	const v2 = path.join(dir, "cloud.excalidrawlib");
	fs.writeFileSync(
		v2,
		JSON.stringify({
			type: "excalidrawlib",
			version: 2,
			libraryItems: [
				{
					id: "lambda-item",
					status: "published",
					name: "Lambda",
					created: 1,
					elements: [
						rect("box", 500, 300, {
							width: 200,
							height: 100,
							groupIds: ["g1"],
							boundElements: [{ id: "label", type: "text" }],
						}),
						{
							type: "text",
							id: "label",
							version: 1,
							x: 520,
							y: 330,
							width: 60,
							height: 25,
							text: "λ fn",
							containerId: "box",
							groupIds: ["g1"],
						},
					],
				},
			],
		}),
	);
	return { v1, v2 };
}

test("library add accepts v1 and v2 files, names unnamed items, and skips re-adds", () => {
	withTempDir((dir) => {
		const { v1, v2 } = writeLibraries(dir);
		let r = runIn(dir, ["library", "add", v1]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /아이템 2개 추가/);
		r = runIn(dir, ["library", "add", v2]);
		assert.match(r.stdout, /아이템 1개 추가 \(총 3개\)/);
		r = runIn(dir, ["library", "add", v1]);
		assert.match(r.stdout, /0개 추가, 이미 있는 2개 건너뜀/);
		r = runIn(dir, ["library", "list"]);
		assert.match(r.stdout, /"shapes #1"/);
		assert.match(r.stdout, /lambda-item {2}"Lambda" {2}요소 2개 {2}200×100 {2}텍스트: λ fn/);
	});
});

test("library add rejects URLs outside the Excalidraw library allowlist", () => {
	withTempDir((dir) => {
		const r = runIn(dir, ["library", "add", "https://excalidraw.com.evil.example/x.excalidrawlib"]);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /허용되지 않은 라이브러리 URL/);
		assert.equal(fs.existsSync(path.join(dir, "library.excalidrawlib")), false);
	});
});

test("library search ranks catalog entries and prints the add key", () => {
	withTempDir((dir) => {
		const catalog = path.join(dir, "catalog.json");
		fs.writeFileSync(
			catalog,
			JSON.stringify([
				{ name: "Network", description: "has aws in text", source: "x/net.excalidrawlib", authors: [] },
				{ name: "AWS Icons", description: "icons", source: "y/aws.excalidrawlib", authors: [] },
				{ name: "Faces", description: "people", source: "z/faces.excalidrawlib", authors: [] },
			]),
		);
		const r = runIn(dir, ["library", "search", "aws"], { EXCAL_LIBRARY_CATALOG: catalog });
		assert.equal(r.status, 0, r.stderr);
		const keys = r.stdout
			.split("\n")
			.filter((l) => /^\S/.test(l))
			.map((l) => l.split("  ")[0]);
		assert.deepEqual(keys, ["y/aws", "x/net"]);
	});
});

test("library insert places a copy with fresh, consistent ids that passes lint", () => {
	withTempDir((dir) => {
		const { v2 } = writeLibraries(dir);
		runIn(dir, ["library", "add", v2]);
		const file = path.join(dir, "d.excalidraw");
		fs.copyFileSync(EXAMPLE, file);
		const before = JSON.parse(fs.readFileSync(file, "utf8")).elements.length;

		const r = runIn(dir, ["library", "insert", file, "lambda", "--at", "40,80", "--width", "100", "--id", "fn"]);
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.box, { x: 40, y: 80, width: 100, height: 50 });
		assert.equal(out.group, "fn");

		const els = JSON.parse(fs.readFileSync(file, "utf8")).elements;
		assert.equal(els.length, before + 2);
		const box = els.find((e) => e.id === "fn-1");
		const label = els.find((e) => e.id === "fn-2");
		assert.equal(label.containerId, "fn-1");
		assert.deepEqual(box.boundElements, [{ id: "fn-2", type: "text" }]);
		assert.deepEqual(box.groupIds, ["fn-g1", "fn"]);
		assert.equal(runIn(dir, ["lint", file]).status, 0);

		const again = runIn(dir, ["library", "insert", file, "lambda", "--id", "fn"]);
		assert.equal(again.status, 1);
		assert.match(again.stderr, /이미 파일에 있습니다/);
	});
});

test("a corrupt library file is reported, kept, and never replaced", () => {
	withTempDir((dir) => {
		const { v1 } = writeLibraries(dir);
		const lib = path.join(dir, "library.excalidrawlib");
		fs.writeFileSync(lib, "{ not json");
		for (const args of [
			["library", "list"],
			["library", "add", v1],
		]) {
			const r = runIn(dir, args);
			assert.equal(r.status, 1, args.join(" "));
			assert.match(r.stderr, /라이브러리 파일이 손상됐습니다/);
		}
		assert.equal(fs.readFileSync(lib, "utf8"), "{ not json");
	});
});

test("library writes keep the previous file as .bak", () => {
	withTempDir((dir) => {
		const { v1, v2 } = writeLibraries(dir);
		runIn(dir, ["library", "add", v1]);
		runIn(dir, ["library", "add", v2]);
		const bak = JSON.parse(fs.readFileSync(path.join(dir, "library.excalidrawlib.bak"), "utf8"));
		assert.equal(bak.libraryItems.length, 2);
	});
});
