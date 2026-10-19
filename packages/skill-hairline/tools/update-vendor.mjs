#!/usr/bin/env node
// Re-vendors @lucasmarkes/hairline from the npm registry into skills/hairline/assets.
// Usage: node tools/update-vendor.mjs [version]   (default: latest)
// The bundle is copied as published, with the upstream MIT notice prepended and the sourcemap link removed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const version = process.argv[2] ?? "latest";
const packageDir = path.resolve(import.meta.dirname, "..");
const assets = path.join(packageDir, "skills/hairline/assets");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "hairline-vendor-"));

try {
	const tarball = execFileSync("npm", ["pack", `@lucasmarkes/hairline@${version}`, "--silent"], {
		cwd: work,
		encoding: "utf8",
	}).trim();
	execFileSync("tar", ["xzf", tarball], { cwd: work });
	const pkgDir = path.join(work, "package");
	const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	if (pkg.license !== "MIT") throw new Error(`license changed to ${pkg.license}; review before vendoring`);
	const deps = Object.keys(pkg.dependencies ?? {});
	if (deps.length > 0) throw new Error(`runtime dependencies appeared (${deps.join(", ")}); review their licenses`);

	const license = fs.readFileSync(path.join(pkgDir, "LICENSE"), "utf8").trim();
	const header = (file) =>
		[
			"/*!",
			` * @lucasmarkes/hairline ${pkg.version}, ${file} as published on npm.`,
			" * https://github.com/lucasmarkes/hairline",
			" * Vendored unchanged except for this comment and the removed sourceMappingURL line.",
			" *",
			...license.split("\n").map((line) => (line ? ` * ${line}` : " *")),
			" */",
			"",
		].join("\n");
	const strip = (source) => source.replace(/\n\/\/# sourceMappingURL=.*\s*$/, "\n");

	fs.mkdirSync(assets, { recursive: true });
	for (const [from, to] of [
		["dist/index.js", "hairline.js"],
		["dist/index.d.ts", "hairline.d.ts"],
	]) {
		const source = strip(fs.readFileSync(path.join(pkgDir, from), "utf8"));
		fs.writeFileSync(path.join(assets, to), header(from) + source);
	}
	fs.writeFileSync(path.join(assets, "LICENSE-hairline"), `${license}\n`);
	const integrity = execFileSync("npm", ["view", `@lucasmarkes/hairline@${pkg.version}`, "dist.integrity"], {
		cwd: work,
		encoding: "utf8",
	}).trim();
	const tag = `v${pkg.version}`;
	const commit = execFileSync("git", ["ls-remote", "https://github.com/lucasmarkes/hairline", `refs/tags/${tag}^{}`], {
		encoding: "utf8",
	}).split("\t")[0];
	fs.writeFileSync(
		path.join(assets, "VERSION"),
		[
			`package: @lucasmarkes/hairline ${pkg.version}`,
			"author: Lucas Marques (https://github.com/lucasmarkes)",
			"license: MIT (LICENSE-hairline)",
			"repository: https://github.com/lucasmarkes/hairline",
			`tag: ${tag}${commit ? ` (${commit})` : ""}`,
			`tarball: https://registry.npmjs.org/@lucasmarkes/hairline/-/hairline-${pkg.version}.tgz`,
			`integrity: ${integrity}`,
			"files: dist/index.js -> hairline.js, dist/index.d.ts -> hairline.d.ts",
			"",
		].join("\n"),
	);
	process.stdout.write(`vendored @lucasmarkes/hairline ${pkg.version} into ${path.relative(packageDir, assets)}\n`);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
