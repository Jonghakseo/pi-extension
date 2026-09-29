#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillDir = path.resolve(__dirname, "..");
const requireFromSkill = createRequire(path.join(skillDir, "package.json"));

function usage(exitCode = 0) {
	const msg = `Usage: node <skill-dir>/scripts/md-to-a4-html.mjs input.md [options]\n\nOptions:\n  -o, --output <file>   Output HTML path (default: input basename + .a4.html)\n  --title <text>        HTML <title> only; visible content is not changed\n  --accent <color>      CSS accent color (default: #1f4e79)\n  --no-cover            Do not give the first H1 a cover-style block\n  -h, --help            Show this help\n`;
	(exitCode ? console.error : console.log)(msg);
	process.exit(exitCode);
}

function parseArgs(argv) {
	const args = { input: null, output: null, title: null, accent: "#1f4e79", cover: true };
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "-h" || a === "--help") usage(0);
		if (a === "-o" || a === "--output") args.output = argv[++i];
		else if (a === "--title") args.title = argv[++i];
		else if (a === "--accent") args.accent = argv[++i];
		else if (a === "--no-cover") args.cover = false;
		else if (!args.input) args.input = a;
		else throw new Error(`Unexpected argument: ${a}`);
	}
	if (!args.input) usage(1);
	if (!args.output) {
		const parsed = path.parse(args.input);
		args.output = path.join(parsed.dir, `${parsed.name}.a4.html`);
	}
	return args;
}

function escapeHtml(s) {
	return String(s)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function extractTitle(markdown, fallback) {
	const h1 = markdown.match(/^#\s+(.+)\s*$/m);
	return h1 ? h1[1].trim() : fallback;
}

function countMarkdownHeadings(markdown) {
	const counts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
	for (const m of markdown.matchAll(/^(#{1,6})\s+\S.*$/gm)) counts[`h${m[1].length}`] += 1;
	return counts;
}

function countHtmlHeadings(html) {
	const counts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
	for (let i = 1; i <= 6; i += 1) counts[`h${i}`] = (html.match(new RegExp(`<h${i}(\\s|>)`, "g")) || []).length;
	return counts;
}

async function loadMarkdownIt() {
	try {
		const mod = await import(requireFromSkill.resolve("markdown-it"));
		return mod.default;
	} catch (err) {
		console.error("Missing dependency: markdown-it");
		console.error(
			`Reinstall the package: pi install npm:@ryan_nookpi/pi-skill-a4 (see ${path.join(skillDir, "references", "setup.md")})`,
		);
		console.error(`Original error: ${err.message}`);
		process.exit(2);
	}
}

function buildHtml({ body, title, sourcePath, markdown, accent, cover }) {
	const hash = crypto.createHash("sha256").update(markdown).digest("hex");
	const generatedAt = new Date().toISOString();
	const coverClass = cover ? " cover-first-h1" : "";
	return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="source-file" content="${escapeHtml(path.resolve(sourcePath))}">
<meta name="source-sha256" content="${hash}">
<style>
:root { --accent: ${accent}; --ink: #1f2933; --muted: #667085; --line: #d9dee7; --paper: #ffffff; --bg: #f3f0ea; }
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR", "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", Arial, sans-serif; font-size: 10.8pt; line-height: 1.72; word-break: keep-all; overflow-wrap: anywhere; }
.document-shell { max-width: 210mm; margin: 0 auto; padding: 18mm 16mm; background: var(--paper); min-height: 297mm; }
.provenance { margin-bottom: 10mm; padding-bottom: 4mm; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 8.5pt; }
.provenance span { display: block; }
.markdown-body > *:first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { color: #111827; line-height: 1.32; page-break-after: avoid; break-after: avoid; }
h1 { margin: 0 0 9mm; font-size: 24pt; letter-spacing: -0.035em; }
.cover-first-h1 h1:first-child { min-height: 45mm; display: flex; align-items: flex-end; padding-bottom: 8mm; border-bottom: 3px solid var(--accent); }
h2 { margin: 10mm 0 4mm; padding-top: 3mm; border-top: 1px solid var(--line); font-size: 15.5pt; color: var(--accent); }
h3 { margin: 7mm 0 2.5mm; font-size: 12.6pt; }
h4, h5, h6 { margin: 5mm 0 2mm; font-size: 11pt; }
p { margin: 0 0 3.4mm; }
ul, ol { margin: 0 0 4mm 0; padding-left: 7mm; }
li { margin: 1.2mm 0; }
li > ul, li > ol { margin-top: 1.2mm; margin-bottom: 1.2mm; }
blockquote { margin: 5mm 0; padding: 3mm 4mm; border-left: 3px solid var(--accent); background: #f7f9fc; color: #344054; }
blockquote p:last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1px solid var(--line); margin: 8mm 0; }
table { width: 100%; border-collapse: collapse; margin: 5mm 0; font-size: 9.6pt; page-break-inside: avoid; break-inside: avoid; }
th, td { border: 1px solid var(--line); padding: 2.4mm 2.8mm; vertical-align: top; }
th { background: #f2f5f9; color: #111827; font-weight: 700; }
code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.92em; background: #f2f4f7; padding: 0.15em 0.32em; border-radius: 3px; }
pre { margin: 5mm 0; padding: 3.5mm; background: #111827; color: #f9fafb; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; page-break-inside: avoid; break-inside: avoid; }
pre code { background: transparent; color: inherit; padding: 0; }
a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
img { max-width: 100%; height: auto; page-break-inside: avoid; break-inside: avoid; }
@media screen { .document-shell { margin-top: 10mm; margin-bottom: 10mm; box-shadow: 0 2mm 12mm rgba(15, 23, 42, 0.10); } }
@media print { html, body { background: #fff; } .document-shell { max-width: none; margin: 0; padding: 0; min-height: auto; box-shadow: none; } .provenance { display: none; } a { color: inherit; } }
</style>
</head>
<body>
<main class="document-shell">
  <div class="provenance">
    <span>Source: ${escapeHtml(path.resolve(sourcePath))}</span>
    <span>SHA-256: ${hash}</span>
    <span>Generated: ${generatedAt}</span>
  </div>
  <article class="markdown-body${coverClass}">
${body}
  </article>
</main>
</body>
</html>
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const inputPath = path.resolve(args.input);
	const markdown = fs.readFileSync(inputPath, "utf8");
	const MarkdownIt = await loadMarkdownIt();
	const md = new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false });
	const rendered = md.render(markdown);
	const title = args.title || extractTitle(markdown, path.basename(inputPath));
	const html = buildHtml({
		body: rendered,
		title,
		sourcePath: inputPath,
		markdown,
		accent: args.accent,
		cover: args.cover,
	});
	fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
	fs.writeFileSync(args.output, html, "utf8");

	const mdHeadings = countMarkdownHeadings(markdown);
	const htmlHeadings = countHtmlHeadings(rendered);
	const headingOk = JSON.stringify(mdHeadings) === JSON.stringify(htmlHeadings);
	console.log(`Wrote ${path.resolve(args.output)}`);
	console.log(`Source SHA-256: ${crypto.createHash("sha256").update(markdown).digest("hex")}`);
	console.log(
		`Heading count check: ${headingOk ? "OK" : "MISMATCH"} markdown=${JSON.stringify(mdHeadings)} html=${JSON.stringify(htmlHeadings)}`,
	);
	if (!headingOk) process.exitCode = 3;
}

main().catch((err) => {
	console.error(err.stack || err.message);
	process.exit(1);
});
