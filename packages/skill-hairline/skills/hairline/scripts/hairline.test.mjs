import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildPage, figures, vendor } from "./hairline.mjs";

const script = path.join(import.meta.dirname, "hairline.mjs");
const assets = path.join(import.meta.dirname, "..", "assets");

test("lists every figure the vendored library exports", async () => {
	const lib = await import(path.join(assets, "hairline.js"));
	assert.deepEqual(
		figures()
			.map((f) => f.name)
			.sort(),
		Object.keys(lib).sort(),
	);
});

test("vendored library and types keep the upstream MIT notice", () => {
	for (const file of ["hairline.js", "hairline.d.ts"]) {
		const head = fs.readFileSync(path.join(assets, file), "utf8").slice(0, 2000);
		assert.match(head, /Copyright \(c\) 2026 Lucas Marques/);
		assert.match(head, /The above copyright notice and this permission notice shall be included/);
	}
});

test("page inlines the library with its notice and mounts only the requested figures", () => {
	const html = buildPage({ names: ["terrain", "vault"], title: "<demo>", theme: "dark", play: true });
	assert.match(html, /Copyright \(c\) 2026 Lucas Marques/);
	assert.doesNotMatch(html, /\nexport \{/);
	assert.equal(html.match(/data-figure="/g).length, 2);
	assert.match(html, /<title>&lt;demo&gt;<\/title>/);
	assert.match(html, /"theme":"dark"/);
	assert.match(html, /color-scheme: dark/);
});

test("page rejects unknown figures and out-of-range options", () => {
	assert.throws(() => buildPage({ names: ["nope"] }), /unknown figure/);
	assert.throws(() => buildPage({ names: [] }), /at least one/);
	assert.throws(() => buildPage({ names: ["terrain"], intensity: 2 }), /intensity/);
	assert.throws(() => buildPage({ names: ["terrain"], theme: "blue" }), /theme/);
});

test("vendor copies the library together with its licence", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hairline-vendor-test-"));
	try {
		vendor(dir);
		assert.deepEqual(fs.readdirSync(dir).sort(), ["LICENSE-hairline", "hairline.d.ts", "hairline.js"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI writes a page and fails with a message on bad input", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hairline-cli-test-"));
	try {
		const out = path.join(dir, "p.html");
		execFileSync(process.execPath, [script, "page", "--figures", "riffle", "--out", out]);
		assert.ok(fs.readFileSync(out, "utf8").includes('data-figure="riffle"'));
		assert.throws(
			() => execFileSync(process.execPath, [script, "page", "--figures", "nope"], { stdio: "pipe" }),
			/unknown figure/,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
