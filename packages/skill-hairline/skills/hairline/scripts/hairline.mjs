#!/usr/bin/env node
// Hairline helper for Pi.
//   node hairline.mjs list
//   node hairline.mjs page --figures terrain,riffle [--out hairline.html] [--title T] [--theme auto|light|dark]
//                          [--intensity 0..1] [--play] [--columns N] [--lang ko]
//   node hairline.mjs vendor <dir>
import fs from "node:fs";
import path from "node:path";

const skillDir = path.resolve(import.meta.dirname, "..");
const assets = path.join(skillDir, "assets");
const LIB = path.join(assets, "hairline.js");
const TYPES = path.join(assets, "hairline.d.ts");
const LICENSE = path.join(assets, "LICENSE-hairline");
const THEMES = ["auto", "light", "dark"];

/** Reads the figure names and their one-line descriptions from the vendored type declarations. */
export function figures() {
	const source = fs.readFileSync(TYPES, "utf8");
	const out = [];
	for (const match of source.matchAll(/\/\*\*\s*([^*]+?)\s*\*\/\s*declare function (\w+)\(/g)) {
		out.push({ name: match[2], description: match[1].replace(/\s+/g, " ") });
	}
	return out;
}

export function version() {
	return fs.readFileSync(LIB, "utf8").match(/@lucasmarkes\/hairline (\S+),/)?.[1] ?? "unknown";
}

function fail(message) {
	process.stderr.write(`hairline: ${message}\n`);
	process.exit(1);
}

function parseArgs(argv) {
	const options = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const key = arg.slice(2);
		if (key === "play") {
			options.play = true;
			continue;
		}
		const value = argv[++i];
		if (value === undefined) fail(`--${key} needs a value`);
		options[key] = value;
	}
	return { options, positional };
}

const escapeHtml = (text) =>
	String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Builds one self-contained HTML page: the vendored library (with its MIT notice) inlined, no network needed. */
export function buildPage({
	names,
	title = "Hairline",
	theme = "auto",
	intensity = 0.5,
	play = false,
	columns,
	lang = "en",
}) {
	const known = new Map(figures().map((f) => [f.name, f]));
	if (names.length === 0) throw new Error("--figures needs at least one figure name");
	const unknown = names.filter((n) => !known.has(n));
	if (unknown.length > 0) throw new Error(`unknown figure(s): ${unknown.join(", ")}. Run "list" to see all.`);
	if (!THEMES.includes(theme)) throw new Error(`--theme must be one of ${THEMES.join(", ")}`);
	if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) throw new Error("--intensity must be 0..1");
	const cols = columns ?? Math.min(names.length, 3);

	const library = fs
		.readFileSync(LIB, "utf8")
		.replace(/\nexport \{[\s\S]*?\};\s*$/, "\n")
		.replaceAll("</script", "<\\/script");
	const scheme = theme === "auto" ? "light dark" : theme;
	const cards = names
		.map(
			(name) => `      <figure class="card">
        <div class="figure" data-figure="${name}"></div>
        <figcaption><span class="name">${name}</span><output class="read" aria-hidden="true"></output></figcaption>
      </figure>`,
		)
		.join("\n");
	const config = JSON.stringify({ names, theme, intensity, play });

	return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!-- Figures: @lucasmarkes/hairline ${version()} (MIT, Copyright (c) 2026 Lucas Marques), https://github.com/lucasmarkes/hairline -->
<style>
  :root { color-scheme: ${scheme}; --bg: light-dark(#ffffff, #08090a); --fg: light-dark(#232327, #d0d6e0); --muted: light-dark(#8a8a93, #5b5d64); --line: light-dark(#e0e0e4, #29292d); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; padding: 48px 24px; }
  h1 { font-size: 18px; font-weight: 500; margin: 0 0 24px; }
  .grid { display: grid; grid-template-columns: repeat(${cols}, minmax(0, 1fr)); gap: 16px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .card { margin: 0; border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .figure { --hairline-plate: var(--bg); width: 100%; }
  figcaption { display: flex; justify-content: space-between; margin-top: 8px; font: 11px/1.4 ui-monospace, monospace; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
</style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <section class="grid">
${cards}
    </section>
  </main>
<script type="module">
${library}
const config = ${config};
const api = { ${figures()
		.map((f) => f.name)
		.join(", ")} };
window.hairline = [];
for (const el of document.querySelectorAll("[data-figure]")) {
  const read = el.parentElement.querySelector(".read");
  const figure = api[el.dataset.figure](el, {
    theme: config.theme,
    intensity: config.intensity,
    play: config.play,
    onRead: (text) => { read.textContent = text; },
  });
  window.hairline.push(figure);
}
</script>
</body>
</html>
`;
}

/** Copies the library, its types and its licence into a project folder for a plain ES module import. */
export function vendor(dir) {
	fs.mkdirSync(dir, { recursive: true });
	for (const file of [LIB, TYPES, LICENSE]) fs.copyFileSync(file, path.join(dir, path.basename(file)));
	return ["hairline.js", "hairline.d.ts", "LICENSE-hairline"].map((f) => path.join(dir, f));
}

function main() {
	const [command, ...rest] = process.argv.slice(2);
	const { options, positional } = parseArgs(rest);
	try {
		if (command === "list") {
			process.stdout.write(`@lucasmarkes/hairline ${version()}: ${figures().length} figures\n`);
			for (const f of figures()) process.stdout.write(`${f.name.padEnd(10)} ${f.description}\n`);
		} else if (command === "page") {
			const out = path.resolve(options.out ?? "hairline.html");
			const html = buildPage({
				names: (options.figures ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
				title: options.title,
				theme: options.theme,
				intensity: options.intensity === undefined ? 0.5 : Number(options.intensity),
				play: options.play === true,
				columns: options.columns === undefined ? undefined : Number(options.columns),
				lang: options.lang,
			});
			fs.writeFileSync(out, html);
			process.stdout.write(`${out}\n`);
		} else if (command === "vendor") {
			if (!positional[0]) fail("vendor needs a target directory");
			for (const file of vendor(path.resolve(positional[0]))) process.stdout.write(`${file}\n`);
		} else {
			fail("usage: hairline.mjs list | page --figures a,b [--out f.html] | vendor <dir>");
		}
	} catch (error) {
		fail(error.message);
	}
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) main();
