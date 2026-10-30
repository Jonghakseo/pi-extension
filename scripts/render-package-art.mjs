#!/usr/bin/env node
// Generates one animated isometric line drawing per maintained package as packages/<dir>/cover.svg.
// The look follows @lucasmarkes/hairline (MIT, (c) 2026 Lucas Marques): same light/dark palette,
// plate-filled faces painted back to front, and hairline strokes. No hairline code is copied.
// Motion is plain CSS inside each SVG, because README images load as <img>, where scripts and
// pointer events are off but CSS animations still run. prefers-reduced-motion freezes every scene.
//
//   node scripts/render-package-art.mjs            # write SVGs
//   node scripts/render-package-art.mjs --preview  # also write an HTML gallery to the OS temp dir

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LIGHT = { plate: "#ffffff", hi: "#232327", edge: "#a4a4ac", mid: "#c3c3c9", lo: "#e0e0e4", cap: "#6e6e76" };
const DARK = { plate: "#08090a", hi: "#d0d6e0", edge: "#5b5d64", mid: "#3e3e44", lo: "#29292d", cap: "#8a8f98" };

const W = 480;
const FIG_H = 384; // 5:4, like hairline
const H = FIG_H + 92;
const EASE = "cubic-bezier(0.5,0,0.1,1)";

// ---------- math ----------
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const AZ = (45 * Math.PI) / 180;
const K = 0.55;
const ZF = Math.sqrt(1 - K * K);
const CA = Math.cos(AZ);
const SA = Math.sin(AZ);
const VIEW = [ZF * SA, ZF * CA, K]; // world-space direction toward the viewer

function project([x, y, z]) {
	const X = x * CA - y * SA;
	const Y = x * SA + y * CA;
	return [X, Y * K - z * ZF];
}
const depthOf = ([x, y, z]) => (x * SA + y * CA) * ZF + z * K;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const avg = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

function hull(points) {
	const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
		lower.push(q);
	}
	const upper = [];
	for (const q of p.reverse()) {
		while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
		upper.push(q);
	}
	return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ---------- scene ----------
// Items are sorted by (layer, depth, insertion order). A group shares one depth so decorations on a
// face are painted right after that face. anim() tags items with a CSS class; consecutive tagged
// items are wrapped in one <g> so the scene's CSS can move or fade them together.
function createScene() {
	const items = [];
	let seq = 0;
	let groupDepth = null;
	let groupLayer = null;
	let animCls = null;
	let animDraw = false;
	let animLayer = 0;

	const push = (layer, anchor, kind, data) => {
		items.push({
			layer: (groupLayer ?? layer) + animLayer,
			depth: groupDepth ?? depthOf(anchor),
			seq: seq++,
			kind,
			anim: animCls,
			draw: animDraw,
			...data,
		});
	};

	const frontRuns = (ring, cd) => {
		let run = [];
		for (const p of ring) {
			if (depthOf(p) >= cd - 1e-6) run.push(p);
			else {
				if (run.length > 1) s.path(run, "");
				run = [];
			}
		}
		if (run.length > 1) s.path(run, "");
	};

	const s = {
		group(anchor, fn, layer = 0) {
			groupDepth = depthOf(anchor);
			groupLayer = layer;
			fn();
			groupDepth = null;
			groupLayer = null;
		},
		anim(cls, fn, { draw = false, layer = 0 } = {}) {
			animCls = cls;
			animDraw = draw;
			animLayer = layer;
			fn();
			animCls = null;
			animDraw = false;
			animLayer = 0;
		},
		poly(pts3, cls = "", { layer = 0, closed = true, fill = true } = {}) {
			push(layer, avg(pts3), "path", { pts: pts3.map(project), cls: fill ? cls : `${cls} nf`, closed });
		},
		line(a, b, cls = "", opts = {}) {
			s.poly([a, b], cls, { ...opts, closed: false, fill: false });
		},
		path(pts3, cls = "", opts = {}) {
			s.poly(pts3, cls, { ...opts, closed: false, fill: false });
		},
		box(x, y, z, w, d, h, cls = "sil", { layer = 0, top = null } = {}) {
			const x1 = x + w;
			const y1 = y + d;
			const z1 = z + h;
			const faces = [
				{
					n: [0, 0, 1],
					v: [
						[x, y, z1],
						[x1, y, z1],
						[x1, y1, z1],
						[x, y1, z1],
					],
					top: true,
				},
				{
					n: [1, 0, 0],
					v: [
						[x1, y, z],
						[x1, y1, z],
						[x1, y1, z1],
						[x1, y, z1],
					],
				},
				{
					n: [-1, 0, 0],
					v: [
						[x, y, z],
						[x, y1, z],
						[x, y1, z1],
						[x, y, z1],
					],
				},
				{
					n: [0, 1, 0],
					v: [
						[x, y1, z],
						[x1, y1, z],
						[x1, y1, z1],
						[x, y1, z1],
					],
				},
				{
					n: [0, -1, 0],
					v: [
						[x, y, z],
						[x1, y, z],
						[x1, y, z1],
						[x, y, z1],
					],
				},
			];
			const center = [x + w / 2, y + d / 2, z + h / 2];
			const draw = () => {
				for (const f of faces) {
					const dot = f.n[0] * VIEW[0] + f.n[1] * VIEW[1] + f.n[2] * VIEW[2];
					if (dot > 1e-6) s.poly(f.v, f.top && top ? top : cls);
				}
			};
			if (groupDepth !== null) draw();
			else s.group(center, draw, layer);
		},
		plate(x, y, w, d, z = 0, h = 0.18) {
			s.box(x, y, z - h, w, d, h, "sil", { layer: -1 });
		},
		circlePts(c, u, v, r, n = 56, a0 = 0, a1 = Math.PI * 2) {
			const out = [];
			for (let i = 0; i <= n; i++) {
				const t = a0 + ((a1 - a0) * i) / n;
				out.push(add(c, add(scale(u, r * Math.cos(t)), scale(v, r * Math.sin(t)))));
			}
			return out;
		},
		circle(c, u, v, r, cls = "", { fill = true, layer = 0 } = {}) {
			s.poly(s.circlePts(c, u, v, r).slice(0, -1), cls, { fill, layer });
		},
		disk(cx, cy, z, r, cls = "", opts = {}) {
			s.circle([cx, cy, z], [1, 0, 0], [0, 1, 0], r, cls, opts);
		},
		cyl(cx, cy, z, r, h, cls = "sil", { top = null } = {}) {
			s.group([cx, cy, z + h / 2], () => {
				const bottom = s.circlePts([cx, cy, z], [1, 0, 0], [0, 1, 0], r, 48);
				const upper = s.circlePts([cx, cy, z + h], [1, 0, 0], [0, 1, 0], r, 48);
				const hullPts = hull([...bottom, ...upper].map(project));
				push(0, [cx, cy, z], "raw", { pts: hullPts, cls, closed: true });
				s.disk(cx, cy, z + h, r, top ?? cls);
			});
		},
		sphere(c, r, cls = "sil") {
			s.group(c, () => {
				const sc = project(c);
				push(0, c, "circle", {
					c: sc,
					r,
					cls,
					pts: [
						[sc[0] - r, sc[1] - r],
						[sc[0] + r, sc[1] + r],
					],
				});
				const cd = depthOf(c);
				for (const lat of [-0.5, 0, 0.5]) {
					const rr = r * Math.cos(lat * 1.1);
					frontRuns(s.circlePts(add(c, [0, 0, r * Math.sin(lat * 1.1)]), [1, 0, 0], [0, 1, 0], rr, 64), cd);
				}
			});
		},
		meridians(c, r, phase) {
			s.group(c, () => {
				for (const lon of [0, 1, 2, 3]) {
					const a = phase + (lon * Math.PI) / 4;
					frontRuns(s.circlePts(c, [Math.cos(a), Math.sin(a), 0], [0, 0, 1], r, 64), depthOf(c));
				}
			});
		},
		dot(p, cls = "dot", r = 2.6) {
			push(5, p, "dot", { c: project(p), r, cls, pts: [project(p)] });
		},
		text(p, str, cls = "tx", { anchor = "middle", size = 11 } = {}) {
			push(6, p, "text", { c: project(p), str, cls, anchor, size, pts: [project(p)] });
		},
		arrow(a, b, cls = "hi", { head = 9 } = {}) {
			s.line(a, b, cls, { layer: 4 });
			push(4, b, "head", { a: project(a), b: project(b), head, cls, pts: [project(b)] });
		},
		items,
	};
	return s;
}

function renderScene(s) {
	const pts = s.items.flatMap((it) => it.pts);
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const [x, y] of pts) {
		minX = Math.min(minX, x);
		maxX = Math.max(maxX, x);
		minY = Math.min(minY, y);
		maxY = Math.max(maxY, y);
	}
	const pad = 44;
	const k = Math.min((W - pad * 2) / (maxX - minX), (FIG_H - pad * 2) / (maxY - minY));
	const ox = W / 2 - ((minX + maxX) / 2) * k;
	const oy = FIG_H / 2 - ((minY + maxY) / 2) * k;
	const T = ([x, y]) => [r1(x * k + ox), r1(y * k + oy)];
	const d = (p, closed) =>
		`M${p
			.map(T)
			.map((q) => q.join(" "))
			.join("L")}${closed ? "Z" : ""}`;

	const sorted = [...s.items].sort((a, b) => a.layer - b.layer || a.depth - b.depth || a.seq - b.seq);
	const out = [];
	let open = null;
	for (const it of sorted) {
		if (it.anim !== open) {
			if (open) out.push("</g>");
			if (it.anim) out.push(`<g class="${it.anim}">`);
			open = it.anim;
		}
		const cls = it.cls ? ` class="${it.cls.trim()}"` : "";
		if (it.kind === "path" || it.kind === "raw") {
			out.push(`<path${cls}${it.draw ? ' pathLength="1"' : ""} d="${d(it.pts, it.closed)}"/>`);
		} else if (it.kind === "circle") {
			const [cx, cy] = T(it.c);
			out.push(`<circle${cls} cx="${cx}" cy="${cy}" r="${r1(it.r * k)}"/>`);
		} else if (it.kind === "dot") {
			const [cx, cy] = T(it.c);
			out.push(`<circle${cls} cx="${cx}" cy="${cy}" r="${it.r}"/>`);
		} else if (it.kind === "text") {
			const [x, y] = T(it.c);
			out.push(`<text${cls} x="${x}" y="${y}" text-anchor="${it.anchor}" font-size="${it.size}">${esc(it.str)}</text>`);
		} else if (it.kind === "head") {
			const [ax, ay] = T(it.a);
			const [bx, by] = T(it.b);
			const len = Math.hypot(bx - ax, by - ay) || 1;
			const ux = (bx - ax) / len;
			const uy = (by - ay) / len;
			const h = it.head;
			const l = [bx - ux * h - uy * h * 0.5, by - uy * h + ux * h * 0.5];
			const r = [bx - ux * h + uy * h * 0.5, by - uy * h - ux * h * 0.5];
			const headCls = it.cls.replace(/\b(dash|march)\b/g, "").trim();
			out.push(`<path class="nf ${headCls}" d="M${r1(l[0])} ${r1(l[1])}L${bx} ${by}L${r1(r[0])} ${r1(r[1])}"/>`);
		}
	}
	if (open) out.push("</g>");
	return { body: out.join(""), k };
}

// ---------- motion ----------
// Every helper returns CSS text. Delays are folded to negative values so each element starts
// mid-cycle instead of waiting, and both fill modes keep the first frame in place.
function motionKit(k) {
	const move = (d) => {
		const [x, y] = project(d);
		return `translate(${r1(x * k)}px,${r1(y * k)}px)`;
	};
	const sec = (v) => `${r2(v)}s`;
	const pc = (v) => `${r2(v)}%`;
	const loop = (sel, name, dur, delay = 0, ease = EASE) =>
		`${sel}{animation:${name} ${sec(dur)} ${ease} ${sec((delay % dur) - dur)} infinite both}`;

	return {
		// n elements .prefix0..n-1 take turns being visible; frame 0 is the static frame
		slots(prefix, n, dur, hold = 1) {
			const p = (100 * hold) / n;
			let css = `@keyframes ${prefix}{0%,${pc(p - 0.01)}{opacity:1}${pc(p)},100%{opacity:0}}`;
			for (let i = 0; i < n; i++) {
				if (i > 0) css += `.${prefix}${i}{opacity:0}`;
				css += loop(`.${prefix}${i}`, prefix, dur, (i * dur) / n, "linear");
			}
			return css;
		},
		appear(name, dur, at, until = 92) {
			return (
				`@keyframes ${name}{0%,${pc(at)}{opacity:0}${pc(at + 5)},${pc(until)}{opacity:1}100%{opacity:0}}` +
				loop(`.${name}`, name, dur, 0, "linear")
			);
		},
		blink(name, dur) {
			return `@keyframes ${name}{0%,49.9%{opacity:1}50%,100%{opacity:0}}${loop(`.${name}`, name, dur, 0, "linear")}`;
		},
		twinkle(name, dur, delay) {
			return loop(`.${name}`, "tw", dur, delay, "ease-in-out");
		},
		float(name, dur, d, delay = 0) {
			return (
				`@keyframes ${name}{0%,100%{transform:translate(0px,0px)}50%{transform:${move(d)}}}` +
				loop(`.${name}`, name, dur, delay, "ease-in-out")
			);
		},
		// stops: [percent, world-space offset, opacity]
		travel(name, dur, stops, { delay = 0, ease = EASE, hidden = false } = {}) {
			const frames = stops.map(([p, d, o]) => `${pc(p)}{transform:${move(d)};opacity:${o}}`).join("");
			return `@keyframes ${name}{${frames}}${hidden ? `.${name}{opacity:0}` : ""}${loop(`.${name}`, name, dur, delay, ease)}`;
		},
		// strokes tagged with anim(..., { draw: true }) are traced from start to end
		drawIn(name, dur, from, to, { end = 92, ease = EASE } = {}) {
			return (
				`@keyframes ${name}{0%,${pc(from)}{stroke-dashoffset:1;opacity:1}${pc(to)},${pc(end)}{stroke-dashoffset:0;opacity:1}100%{stroke-dashoffset:0;opacity:0}}` +
				`.${name} path{stroke-dasharray:1 1}${loop(`.${name} path`, name, dur, 0, ease)}`
			);
		},
		// a wave across .prefix0..n-1: each lights up (and optionally lifts) in turn
		chase(prefix, n, dur, { lift = null, hold = 1 } = {}) {
			const h = (100 * hold) / n;
			let css = `@keyframes ${prefix}L{0%{stroke:var(--edge)}${pc(h / 2)}{stroke:var(--hi)}${pc(h)},100%{stroke:var(--edge)}}`;
			if (lift) {
				css += `@keyframes ${prefix}{0%{transform:translate(0px,0px)}${pc(h / 2)}{transform:${move(lift)}}${pc(h)},100%{transform:translate(0px,0px)}}`;
			}
			for (let i = 0; i < n; i++) {
				const delay = (i * dur) / n;
				if (lift) css += loop(`.${prefix}${i}`, prefix, dur, delay, "ease-in-out");
				css += loop(`.${prefix}${i} path`, `${prefix}L`, dur, delay, "ease-in-out");
			}
			return css;
		},
	};
}

function wrap(text, max) {
	const lines = [""];
	for (const word of text.split(" ")) {
		const cur = lines.at(-1);
		if (cur && `${cur} ${word}`.length > max) lines.push(word);
		else lines[lines.length - 1] = cur ? `${cur} ${word}` : word;
	}
	return lines;
}

const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function svgDoc(name, kind, desc, body, motion) {
	const vars = (p) =>
		Object.entries(p)
			.map(([k2, v]) => `--${k2}:${v};`)
			.join("");
	const style = [
		`svg{${vars(LIGHT)}}`,
		`@media (prefers-color-scheme:dark){svg{${vars(DARK)}}}`,
		".bg{fill:var(--plate);stroke:var(--lo)}",
		".fig path,.fig circle{fill:var(--plate);stroke:var(--mid);stroke-width:1;stroke-linejoin:round;stroke-linecap:round}",
		".fig .nf{fill:none}",
		".fig .sil,.fig .edge{stroke:var(--edge)}",
		".fig .hi{stroke:var(--hi)}",
		".fig .lo{stroke:var(--lo)}",
		".fig .dash{stroke-dasharray:2 4}",
		".fig .dot{stroke:none;fill:var(--hi)}",
		".fig .dot.m{fill:var(--edge)}",
		".fig .dot.off{fill:var(--lo)}",
		"text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
		".tx{fill:var(--edge)}",
		".tx.hi{fill:var(--hi)}",
		".name{fill:var(--hi);font-size:16px;font-weight:600}",
		".kind{fill:var(--edge);font-size:11px;letter-spacing:.08em}",
		".desc{fill:var(--cap);font-size:12.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}",
		"@keyframes march{to{stroke-dashoffset:-12}}",
		"@keyframes tw{0%,100%{opacity:1}50%{opacity:.15}}",
		".fig .march{animation:march .9s linear infinite}",
		motion,
		// :root .fig * outranks every motion selector, so no !important is needed
		"@media (prefers-reduced-motion:reduce){:root .fig,:root .fig *{animation:none}}",
	].join("");
	const caption = wrap(desc, 70)
		.map((l, i) => `<text class="desc" x="28" y="${FIG_H + 42 + i * 18}">${esc(l)}</text>`)
		.join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">${esc(name)}</title><desc id="d">${esc(desc)}</desc>
<style>${style}</style>
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14"/>
<g class="fig">${body}</g>
<text class="name" x="28" y="${FIG_H + 14}">${esc(name)}</text>
<text class="kind" x="${W - 28}" y="${FIG_H + 14}" text-anchor="end">${kind.toUpperCase()}</text>
${caption}
</svg>
`;
}

// ---------- helpers for common shapes ----------
const X = [1, 0, 0];
const Y = [0, 1, 0];
const Z = [0, 0, 1];

// text-ish bars on the +y face of a panel (plane y = yf), x from x0, at height z
function barsXZ(s, x0, yf, zTop, widths, gap = 0.55, cls = "") {
	widths.forEach((w, i) => {
		s.line([x0, yf, zTop - i * gap], [x0 + w, yf, zTop - i * gap], cls);
	});
}
// bars on a top face at height z, running along x, stacked along y
function barsTop(s, x0, y0, z, widths, gap = 0.45, cls = "") {
	widths.forEach((w, i) => {
		s.line([x0, y0 + i * gap, z], [x0 + w, y0 + i * gap, z], cls);
	});
}
// a standing window: panel in the xz plane facing +y, with a title bar
function windowPanel(s, x, y, z, w, h, { depth = 0.3, cls = "sil", content } = {}) {
	s.group([x + w / 2, y + depth / 2, z + h / 2], () => {
		s.box(x, y, z, w, depth, h, cls);
		const yf = y + depth + 0.01;
		s.line([x, yf, z + h - 0.7], [x + w, yf, z + h - 0.7], cls);
		for (const dx of [0.35, 0.75, 1.15]) s.circle([x + dx, yf, z + h - 0.35], X, Z, 0.13, "", { fill: false });
		content?.(yf);
	});
}
const rectXZ = (x0, x1, yf, z0, z1) => [
	[x0, yf, z0],
	[x1, yf, z0],
	[x1, yf, z1],
	[x0, yf, z1],
];
const check = (x, yf, z) => [
	[x, yf, z],
	[x + 0.2, yf, z - 0.2],
	[x + 0.6, yf, z + 0.25],
];

// ---------- scenes ----------
const SCENES = {
	"ask-user-question": {
		kind: "extension",
		desc: "Stops mid-task to ask you a radio, checkbox, or free-text question.",
		draw(s) {
			s.plate(0, 0, 10, 8);
			windowPanel(s, 1.6, 3, 0.15, 6.8, 5.6, {
				content(yf) {
					s.line([2.1, yf, 5.2], [5.6, yf, 5.2], "hi");
					const widths = [3.2, 2.4, 2.8];
					[4.1, 3.0, 1.9].forEach((zc, i) => {
						s.circle([2.5, yf, zc], X, Z, 0.26, "", { fill: false });
						s.line([3.1, yf, zc], [3.1 + widths[i], yf, zc], "");
						s.anim(`q${i}`, () => {
							s.circle([2.5, yf, zc], X, Z, 0.26, "hi", { fill: false });
							s.circle([2.5, yf, zc], X, Z, 0.11, "hi");
							s.line([3.1, yf, zc], [3.1 + widths[i], yf, zc], "hi");
						});
					});
				},
			});
			s.box(6.0, 3.3, 0.55, 1.8, 0.35, 0.75, "hi");
			s.anim("qm", () => s.text([8.6, 2, 7.6], "?", "tx hi", { size: 30 }));
		},
		motion: (m) => m.slots("q", 3, 4.5) + m.float("qm", 2.4, [0, 0, 0.5]),
	},
	"auto-name": {
		kind: "extension",
		desc: "Names each session from its first message, so open tabs stay readable.",
		draw(s) {
			s.plate(0, 0, 12, 8);
			[0, 1, 2].forEach((i) => {
				const y = 1 + i * 2.1;
				s.group([3, y + 0.8, 0.2], () => {
					s.box(1, y, 0, 4.4, 1.6, 0.18, "sil");
					barsTop(s, 1.4, y + 0.45, 0.19, [3.2 - i * 0.4, 2.2 - i * 0.4], 0.6, i === 0 ? "hi" : "");
				});
			});
			s.arrow([5.8, 1.8, 0.6], [7.6, 1.8, 2.6], "hi dash march");
			s.group([9.5, 2, 3.4], () => {
				s.box(7.6, 1.6, 2.6, 3.8, 0.35, 1.5, "hi");
				s.anim("n0", () => s.line([8.1, 1.96, 3.6], [10.7, 1.96, 3.6], "hi"), { draw: true });
				s.anim("n1", () => s.line([8.1, 1.96, 3.1], [9.8, 1.96, 3.1], ""), { draw: true });
			});
			s.line([9.5, 1.8, 4.1], [9.5, 1.8, 5.2], "");
			s.dot([9.5, 1.8, 5.2], "dot m");
		},
		motion: (m) => m.drawIn("n0", 4, 10, 40) + m.drawIn("n1", 4, 35, 60),
	},
	"bash-async": {
		kind: "extension",
		desc: "Runs long shell commands in the background and reports when they finish.",
		draw(s) {
			s.plate(0, 0, 13, 9);
			s.line([1, 1.6, 0.01], [12, 1.6, 0.01], "lo");
			s.line([1, 3.4, 0.01], [12, 3.4, 0.01], "lo");
			[1.8, 5.2, 8.6].forEach((x, i) => {
				s.group([x + 0.9, 2.5, 0.7], () => {
					s.box(x, 1.8, 0, 1.8, 1.4, 1.2, i === 2 ? "hi" : "sil");
					s.line([x + 0.2, 2.5, 1.21], [x + 1.6, 2.5, 1.21], "lo");
					s.anim(`bj${i}`, () => s.line([x + 0.2, 2.5, 1.21], [x + 1.6, 2.5, 1.21], "hi"), { draw: true });
				});
			});
			s.anim("bd", () => {
				s.line([9.5, 2.5, 1.3], [9.5, 2.5, 2.9], "hi");
				s.dot([9.5, 2.5, 3.0]);
				s.text([9.5, 2.5, 3.55], "done", "tx hi");
			});
			windowPanel(s, 1.2, 5.6, 0.15, 6, 3.6, {
				content(yf) {
					s.text([1.75, yf, 2.25], "$", "tx hi", { anchor: "start" });
					s.line([2.3, yf, 2.35], [5.6, yf, 2.35], "hi");
					barsXZ(s, 1.8, yf, 1.6, [3.4, 2.2], 0.55);
					s.anim("bc", () => s.poly(rectXZ(5.8, 6.1, yf, 2.15, 2.55), "hi"));
				},
			});
			s.path(
				[
					[4.2, 5.6, 0.4],
					[4.2, 4.3, 0.4],
					[2.7, 4.3, 0.4],
					[2.7, 3.2, 0.4],
				],
				"dash march",
			);
		},
		motion: (m) =>
			m.drawIn("bj0", 6, 0, 88, { end: 95, ease: "linear" }) +
			m.drawIn("bj1", 6, 0, 60, { end: 95, ease: "linear" }) +
			m.drawIn("bj2", 6, 0, 30, { end: 95, ease: "linear" }) +
			m.appear("bd", 6, 30, 95) +
			m.blink("bc", 1),
	},
	"enhanced-bash": {
		kind: "extension",
		desc: "A bash tool with UI titles that moves commands outliving their timeout to the background.",
		draw(s) {
			s.plate(0, 0, 13, 9);
			s.line([1, 1.6, 0.01], [12, 1.6, 0.01], "lo");
			s.line([1, 3.4, 0.01], [12, 3.4, 0.01], "lo");
			[1.8, 5.2].forEach((x, i) => {
				s.group([x + 0.9, 2.5, 0.7], () => {
					s.box(x, 1.8, 0, 1.8, 1.4, 1.2, "sil");
					s.line([x + 0.2, 2.5, 1.21], [x + 1.6, 2.5, 1.21], "lo");
					s.anim(`eb${i}`, () => s.line([x + 0.2, 2.5, 1.21], [x + 1.6, 2.5, 1.21], "hi"), { draw: true });
				});
			});
			s.anim("ej", () => {
				s.group([9.5, 2.5, 0.7], () => {
					s.box(8.6, 1.8, 0, 1.8, 1.4, 1.2, "hi");
					s.line([8.8, 2.5, 1.21], [10.2, 2.5, 1.21], "lo");
				});
			});
			s.anim("ep", () => s.line([8.8, 2.5, 1.22], [10.2, 2.5, 1.22], "hi"), { draw: true, layer: 2 });
			s.anim("ed", () => {
				s.line([9.5, 2.5, 1.3], [9.5, 2.5, 2.9], "hi");
				s.dot([9.5, 2.5, 3.0]);
				s.text([9.5, 2.5, 3.55], "done", "tx hi");
			});
			windowPanel(s, 1.2, 5.6, 0.15, 6, 3.6, {
				content(yf) {
					s.text([1.75, yf, 2.25], "$", "tx hi", { anchor: "start" });
					s.line([2.3, yf, 2.35], [5.6, yf, 2.35], "hi");
					barsXZ(s, 1.8, yf, 1.7, [3.2], 0.55, "lo");
					s.line([1.8, yf, 0.8], [6.6, yf, 0.8], "lo");
					s.anim("et", () => s.line([1.8, yf, 0.8], [6.6, yf, 0.8], "hi"), { draw: true });
				},
			});
			s.text([1.3, 5.6, 4.35], "title: run e2e tests", "tx hi", { anchor: "start", size: 11 });
			s.path(
				[
					[7.2, 5.6, 0.4],
					[9.5, 5.6, 0.4],
					[9.5, 3.2, 0.4],
				],
				"dash march",
			);
		},
		motion: (m) =>
			m.drawIn("eb0", 6, 0, 70, { end: 95, ease: "linear" }) +
			m.drawIn("eb1", 6, 0, 40, { end: 95, ease: "linear" }) +
			m.drawIn("et", 6, 4, 44, { end: 50, ease: "linear" }) +
			m.travel(
				"ej",
				6,
				[
					[0, [0, 3.4, 0], 0],
					[45, [0, 3.4, 0], 0],
					[48, [0, 3.4, 0], 1],
					[62, [0, 0, 0], 1],
					[94, [0, 0, 0], 1],
					[100, [0, 0, 0], 0],
				],
				{ ease: "linear" },
			) +
			m.drawIn("ep", 6, 62, 82, { end: 94, ease: "linear" }) +
			m.appear("ed", 6, 82, 94),
	},
	"cc-system-prompt": {
		kind: "extension",
		desc: "Swaps pi's system prompt for Claude Code's when a Claude model is selected.",
		draw(s) {
			s.plate(0, 0, 12, 9);
			s.box(3, 2, 0.1, 6, 5, 0.35, "sil");
			s.anim("cl", () => {
				s.group([6, 4.5, 2.2], () => {
					s.box(3, 2, 2, 6, 5, 0.35, "hi");
					barsTop(s, 3.6, 2.8, 2.36, [4.2, 3.4, 4.6, 2.6, 3.8], 0.8, "hi");
				});
				s.text([9.6, 4.5, 2.3], "claude code", "tx hi", { anchor: "start" });
			});
			s.box(3, 2, 3.9, 6, 5, 0.35, "sil");
			s.anim("gp", () => {
				const ghost = [
					[3, -4.4, 2],
					[9, -4.4, 2],
					[9, -1.2, 2],
					[3, -1.2, 2],
				];
				s.poly(ghost, "edge dash", { fill: false, layer: 3 });
				s.text([9.4, -2.8, 2.0], "pi prompt", "tx", { anchor: "start" });
			});
			s.arrow([6, 1.6, 2.2], [6, -0.8, 2.2], "dash march");
		},
		motion: (m) =>
			m.travel("cl", 5, [
				[0, [4, 0, 0], 0],
				[30, [0, 0, 0], 1],
				[88, [0, 0, 0], 1],
				[100, [0, 0, 0], 0],
			]) +
			m.travel("gp", 5, [
				[0, [0, 4, 0], 0],
				[30, [0, 0, 0], 1],
				[88, [0, 0, 0], 1],
				[100, [0, 0, 0], 0],
			]),
	},
	"claude-hooks-bridge": {
		kind: "extension",
		desc: "Runs the hooks in .claude/settings.json on pi's lifecycle events.",
		draw(s) {
			s.plate(0, 0, 14, 7);
			s.box(0.6, 1.5, 0, 3, 4, 3, "sil");
			s.text([2.1, 3.5, 3.9], ".claude", "tx");
			s.box(10.4, 1.5, 0, 3, 4, 3, "sil");
			s.text([11.9, 3.5, 3.9], "pi", "tx hi");
			s.group([7, 3.5, 2.7], () => {
				s.box(3.6, 3, 2.6, 6.8, 1, 0.25, "sil");
			});
			const hooks = ["SessionStart", "PreToolUse", "Stop"];
			[5, 7, 9].forEach((x, i) => {
				s.line([x, 3.5, 2.86], [x, 3.5, 4.2], "");
				s.dot([x, 3.5, 4.3], "dot m");
				s.anim(`hk${i}`, () => {
					s.line([x, 3.5, 2.86], [x, 3.5, 4.2], "hi");
					s.dot([x, 3.5, 4.3]);
					s.text([x, 3.5, 5.0], hooks[i], "tx hi");
				});
			});
			s.arrow([4.2, 3.5, 2.95], [9.8, 3.5, 2.95], "hi");
			s.anim("hp", () => s.dot([4.4, 3.5, 2.95], "dot", 3.4));
		},
		motion: (m) =>
			m.slots("hk", 3, 4.5) +
			m.travel(
				"hp",
				1.5,
				[
					[0, [0, 0, 0], 0],
					[15, [0.6, 0, 0], 1],
					[85, [5, 0, 0], 1],
					[100, [5.4, 0, 0], 0],
				],
				{ hidden: true, ease: "linear" },
			),
	},
	"claude-spinner": {
		kind: "extension",
		desc: "Swaps the working indicator for Claude's · ✻ ✽ ✶ ✳ ✢ frames.",
		draw(s) {
			s.disk(0, 0, 0, 5, "sil", { layer: -1 });
			const n = 8;
			for (let i = 0; i < n; i++) {
				const a = (i / n) * Math.PI * 2;
				const x = Math.cos(a) * 3.2;
				const y = Math.sin(a) * 3.2;
				s.anim(`sp${i}`, () => s.box(x - 0.45, y - 0.45, 0, 0.9, 0.9, 1.2, "sil"));
			}
			["·", "✻", "✽", "✶", "✳", "✢"].forEach((g, i) => {
				s.anim(`gl${i}`, () => s.text([-0.6, -0.6, 3.4], g, "tx hi", { size: 34 }));
			});
		},
		motion: (m) => m.chase("sp", 8, 1.6, { lift: [0, 0, 1.4], hold: 2.5 }) + m.slots("gl", 6, 0.9),
	},
	clipboard: {
		kind: "extension",
		desc: "Copies text to the system clipboard and reads it back on request.",
		draw(s) {
			s.plate(0, 0, 12, 8);
			s.group([4, 3.2, 3.4], () => {
				s.box(1.5, 3, 0.15, 5, 0.35, 6.4, "sil");
				barsXZ(s, 2.1, 3.36, 4.9, [3.6, 2.6, 3.2, 2.0], 0.75);
			});
			s.box(3.2, 2.85, 6.1, 1.6, 0.7, 0.8, "hi");
			s.group([9.6, 5, 3.2], () => {
				s.box(8, 3.8, 3.1, 3.2, 2.4, 0.12, "hi");
				barsTop(s, 8.4, 4.3, 3.23, [2.2, 1.6, 2.4], 0.6, "");
			});
			s.arrow([6.9, 3.4, 4.2], [8.2, 3.9, 3.4], "hi");
			s.arrow([9.6, 5.8, 2.9], [9.6, 5.8, 0.6], "dash march");
			s.text([10.2, 6.6, 1.6], "paste", "tx", { anchor: "start" });
			s.text([7.4, 2.6, 5.0], "copy", "tx hi");
			s.anim("cp", () => s.box(5.6, 3.0, 4.5, 1.0, 0.7, 0.1, "hi"), { layer: 3 });
			s.anim("cq", () => s.box(9.1, 5.4, 2.2, 1.0, 0.7, 0.1, "hi"), { layer: 3 });
		},
		motion: (m) =>
			m.travel(
				"cp",
				4,
				[
					[0, [0, 0, 0], 0],
					[8, [0, 0, 0], 1],
					[40, [3.2, 1.4, -1.0], 1],
					[48, [3.2, 1.4, -1.0], 0],
					[100, [3.2, 1.4, -1.0], 0],
				],
				{ hidden: true },
			) +
			m.travel(
				"cq",
				4,
				[
					[0, [0, 0, 0], 0],
					[50, [0, 0, 0], 0],
					[58, [0, 0, 0], 1],
					[88, [0, 0, -1.6], 1],
					[100, [0, 0, -1.6], 0],
				],
				{ hidden: true },
			),
	},
	"codex-fast-mode": {
		kind: "extension",
		desc: "Toggles a faster, terser Codex setup per session with /codex-fast.",
		draw(s) {
			s.plate(0, 1, 15, 6);
			s.group([7.5, 4, 0.1], () => {
				s.box(0.5, 2.6, 0, 14, 2.8, 0.25, "sil");
				for (let i = 0; i < 5; i++) {
					const x = 1.4 + i * 1.4;
					const chevron = [
						[x, 3.3, 0.26],
						[x + 0.6, 4, 0.26],
						[x, 4.7, 0.26],
					];
					s.path(chevron, "");
					s.anim(`cv${i}`, () => s.path(chevron, "hi"));
				}
			});
			[0.9, 1.6, 2.3].forEach((z, i) => {
				s.line([4 + i * 1.2, 3, z], [9.1, 3, z], "dash march", { layer: 3 });
			});
			s.box(9.2, 3, 0.25, 2.8, 2, 2.4, "hi");
			s.text([10.6, 4, 3.4], "priority", "tx hi");
		},
		motion: (m) => m.slots("cv", 5, 1, 2),
	},
	cron: {
		kind: "extension",
		desc: "Runs scheduled Pi jobs from a detached daemon that survives restarts.",
		draw(s) {
			s.plate(0, 0, 12, 10);
			s.box(4.4, 1, 0, 1.2, 1, 1.4, "sil");
			const c = [5, 1.3, 4.6];
			const at = (a, r) => add(c, add(scale(X, r * Math.sin(a)), scale(Z, r * Math.cos(a))));
			s.group([5, 1.5, 4.6], () => {
				s.circle(c, X, Z, 3, "sil");
				for (let i = 0; i < 12; i++) {
					const a = (i / 12) * Math.PI * 2;
					s.line(at(a, 2.6), at(a, i % 3 === 0 ? 2.15 : 2.35), i % 3 === 0 ? "hi" : "");
				}
				s.line(c, at(Math.PI / 3, 1.3), "hi");
				for (let i = 0; i < 12; i++) {
					s.anim(`mh${i}`, () => s.line(c, at((i / 12) * Math.PI * 2, 2.1), "hi"));
				}
			});
			const lit = [
				[0, 1],
				[1, 3],
				[0, 4],
			];
			for (let r = 0; r < 2; r++) {
				for (let q = 0; q < 5; q++) s.box(1 + q * 2, 5.6 + r * 2, 0, 1.6, 1.6, 0.25, "sil");
			}
			lit.forEach(([r, q], i) => {
				const x = 1 + q * 2;
				const y = 5.6 + r * 2;
				s.anim(`ct${i}`, () => {
					s.box(x, y, 0, 1.6, 1.6, 0.25, "hi");
					s.dot([x + 0.8, y + 0.8, 0.26]);
				});
			});
		},
		motion: (m) => m.slots("mh", 12, 6) + m.slots("ct", 3, 6),
	},
	"cross-agent": {
		kind: "extension",
		desc: "Loads commands from Claude, Gemini, and Codex agent folders into pi.",
		draw(s) {
			s.plate(0, 0, 13, 11);
			const sources = [
				[1, ".claude"],
				[5, ".gemini"],
				[9, ".codex"],
			];
			sources.forEach(([x, label], i) => {
				s.box(x, 0.8, 0, 2.6, 2, 1.6, "sil");
				s.box(x, 0.8, 1.6, 1.1, 2, 0.3, "sil");
				s.text([x + 1.3, 1.8, 2.9], label, "tx");
				s.path(
					[
						[x + 1.3, 2.9, 0.02],
						[x + 1.3, 5.2, 0.02],
						[6.5, 6.4, 0.02],
					],
					"dash",
				);
				s.anim(`ca${i}`, () => s.box(x + 0.6, 3.0, 0.5, 1.4, 0.9, 0.08, "hi"), { layer: 3 });
			});
			s.group([6.5, 8.2, 0.6], () => {
				s.box(4, 6.6, 0, 5, 3.2, 0.9, "hi");
				barsTop(s, 4.6, 7.3, 0.91, [3.4, 2.6, 3.0], 0.7, "");
			});
			s.text([6.5, 8.2, 2.1], "pi", "tx hi");
		},
		motion: (m) =>
			[1, 5, 9]
				.map((x, i) => {
					const end = [6.5 - (x + 1.3), 4.75, 0.6];
					return m.travel(
						`ca${i}`,
						4.5,
						[
							[0, [0, 0, 0], 0],
							[8, [0, 0, 0], 1],
							[40, [0, 2.2, 0], 1],
							[75, end, 1],
							[85, end, 0],
							[100, end, 0],
						],
						{ hidden: true, delay: i * 1.5 },
					);
				})
				.join(""),
	},
	"delayed-action": {
		kind: "extension",
		desc: "Queues a follow-up prompt that fires after a delay like 5m or 1h.",
		draw(s) {
			s.plate(0, 0, 14, 7);
			s.line([0.6, 3.5, 0.01], [13.4, 3.5, 0.01], "lo");
			s.anim(
				"pb",
				() => {
					s.box(1.6, 2.6, 0, 2.4, 1.8, 1.2, "hi");
					s.line([2.0, 4.41, 0.75], [3.6, 4.41, 0.75], "hi");
				},
				{ layer: 3 },
			);
			for (const y of [2, 5]) s.box(5.2, y - 0.3, 0, 0.6, 0.6, 2.8, "sil");
			s.anim("gt", () => s.box(5.25, 1.9, 1.3, 0.5, 3.2, 0.35, "hi"));
			const c = [2.8, 3.5, 3.6];
			s.group(c, () => {
				s.circle(c, X, Z, 1.1, "sil");
				s.line(c, add(c, [0, 0, 0.5]), "");
				for (let i = 0; i < 4; i++) {
					const a = (i / 4) * Math.PI * 2;
					s.anim(`dh${i}`, () => s.line(c, add(c, [0.8 * Math.sin(a), 0, 0.8 * Math.cos(a)]), "hi"));
				}
			});
			s.text([2.8, 3.5, 5.3], "5m", "tx hi");
			s.arrow([6.2, 3.5, 0.6], [8.6, 3.5, 0.6], "dash march");
			[0, 1, 2].forEach((i) => {
				s.box(9, 2.2, 0.1 + i * 0.6, 3.6, 2.6, 0.18, i === 2 ? "hi" : "sil");
			});
		},
		motion: (m) =>
			m.slots("dh", 4, 6) +
			m.travel("gt", 6, [
				[0, [0, 0, 0], 1],
				[45, [0, 0, 0], 1],
				[55, [0, 0, 1.6], 1],
				[85, [0, 0, 1.6], 1],
				[95, [0, 0, 0], 1],
				[100, [0, 0, 0], 1],
			]) +
			m.travel("pb", 6, [
				[0, [0, 0, 0], 1],
				[52, [0, 0, 0], 1],
				[80, [7.2, 0, 1.5], 1],
				[90, [7.2, 0, 1.5], 0],
				[94, [0, 0, 0], 0],
				[100, [0, 0, 0], 1],
			]),
	},
	"diff-review": {
		kind: "extension",
		desc: "Opens a native diff review window and sends your comments back to pi.",
		draw(s) {
			s.plate(0, 0, 13, 7);
			windowPanel(s, 0.8, 2.4, 0.15, 11.4, 6.2, {
				content(yf) {
					s.line([6.5, yf, 0.4], [6.5, yf, 5.4], "");
					const left = [3.8, 3, 4.2, 2.6, 3.4, 2.2];
					const right = [3.8, 0, 0, 2.6, 3.4, 2.2];
					[4.8, 4.1, 3.4, 2.7, 2.0, 1.3].forEach((z, i) => {
						const removed = i === 1 || i === 2;
						s.line([1.4, yf, z], [1.4 + left[i], yf, z], removed ? "lo dash" : "");
						if (!removed) s.line([7.1, yf, z], [7.1 + right[i], yf, z], "");
					});
				},
			});
			s.anim("dr0", () => {
				s.box(7, 2.7, 3.15, 4.6, 0.6, 0.45, "hi");
				s.text([6.9, 3.4, 3.65], "+", "tx hi", { anchor: "end", size: 14 });
			});
			s.anim("dr1", () => s.box(7, 2.7, 2.45, 3.6, 0.6, 0.45, "hi"));
			s.text([1.25, 2.7, 3.85], "-", "tx", { anchor: "end", size: 14 });
			s.anim("dc", () => {
				s.group([11, 5.3, 1.6], () => {
					s.box(9.6, 4.4, 0.6, 2.8, 1.8, 0.14, "sil");
					barsTop(s, 9.9, 4.9, 0.75, [2.0, 1.4], 0.6, "hi");
				});
			});
			s.line([10.6, 3.2, 2.45], [10.6, 4.6, 0.75], "dash march");
		},
		motion: (m) => m.appear("dr0", 5, 10) + m.appear("dr1", 5, 25) + m.float("dc", 2.6, [0, 0, 0.4]),
	},
	"generative-ui": {
		kind: "extension",
		desc: "Opens charts, diagrams, and mockups the model writes in a native window.",
		draw(s) {
			s.plate(0, 0, 12, 10);
			s.group([6, 8, 0.4], () => {
				s.box(2.5, 7, 0, 7, 2, 0.4, "sil");
				s.text([3, 8, 0.42], ">", "tx hi", { anchor: "start" });
				s.line([3.6, 8, 0.41], [7.6, 8, 0.41], "hi");
			});
			for (const [x, y] of [
				[3, 7],
				[9, 7],
			]) {
				s.line([x, y, 0.4], [x, y - 2, 3.4], "dash march");
			}
			s.anim("gw", () => {
				s.box(1.5, 0.8, 3.4, 9, 5.6, 0.18, "sil", { layer: -1 });
				s.group([8, 2.5, 3.8], () => {
					s.box(6.6, 1.5, 3.58, 3.2, 2, 0.3, "hi");
					barsTop(s, 7, 2.1, 3.89, [2.2, 1.4], 0.7, "");
				});
				s.cyl(8.2, 5.0, 3.58, 0.7, 0.3, "sil");
				s.box(2.4, 1.4, 3.58, 3.4, 0.9, 0.3, "sil");
			});
			[
				[2.4, 1.2],
				[3.6, 0.7],
				[4.8, 1.8],
			].forEach(([x, h], i) => {
				s.anim(`gb${i}`, () => s.box(x, 3.2, 3.58, 0.9, 0.9, h, i === 2 ? "hi" : "sil"));
			});
		},
		motion: (m) =>
			m.travel("gw", 5, [
				[0, [0, 0, -1.2], 0],
				[25, [0, 0, 0], 1],
				[92, [0, 0, 0], 1],
				[100, [0, 0, 0], 0],
			]) + [0, 1, 2].map((i) => m.appear(`gb${i}`, 5, 30 + i * 8)).join(""),
	},
	"idle-screensaver": {
		kind: "extension",
		desc: "Covers an idle session with a quiet full-screen overlay until a key is pressed.",
		draw(s) {
			s.plate(0, 0, 12, 9);
			s.box(5.4, 2.2, 0, 1.2, 1, 1.6, "sil");
			s.group([6, 2.6, 4.5], () => {
				s.box(1.5, 2, 1.6, 9, 0.4, 5.6, "sil");
				const yf = 2.41;
				const stars = [
					[2.6, 6.3],
					[4.1, 5.4],
					[3.2, 3.2],
					[8.9, 6.1],
					[9.6, 4.0],
					[7.6, 2.6],
					[5.0, 2.4],
				];
				stars.forEach(([x, z], i) => {
					s.anim(`st${i}`, () => s.circle([x, yf, z], X, Z, 0.07, "hi"));
				});
				s.line([4.3, yf, 4.4], [7.7, yf, 4.4], "hi");
				s.line([4.9, yf, 3.8], [7.1, yf, 3.8], "");
			});
			s.box(3, 5, 0, 6, 2.4, 0.3, "sil");
			s.anim("z0", () => s.text([10.6, 2.2, 8.0], "z", "tx", { size: 13 }));
			s.anim("z1", () => s.text([11.4, 2.2, 8.9], "Z", "tx hi", { size: 18 }));
		},
		motion: (m) => {
			const rise = [
				[0, [0, 0, 0], 0],
				[20, [0, 0, 0.2], 1],
				[100, [0.4, 0, 1.6], 0],
			];
			return (
				[0, 1, 2, 3, 4, 5, 6].map((i) => m.twinkle(`st${i}`, 2.4, i * 0.37)).join("") +
				m.travel("z0", 3, rise, { ease: "linear" }) +
				m.travel("z1", 3, rise, { ease: "linear", delay: 1.5 })
			);
		},
	},
	"memory-layer": {
		kind: "extension",
		desc: "Remembers, recalls, and forgets facts across sessions in three tiers.",
		draw(s) {
			s.plate(0, 0, 11, 11);
			s.group([4.5, 3, 3], () => {
				s.box(2, 1, 0, 5, 4, 6, "sil");
				const yf = 5.01;
				for (const [z0, z1] of [
					[0.3, 1.9],
					[4.1, 5.7],
				]) {
					s.poly(rectXZ(2.3, 6.7, yf, z0, z1), "", { fill: false });
					s.line([4, yf, (z0 + z1) / 2 + 0.2], [5, yf, (z0 + z1) / 2 + 0.2], "hi");
				}
				s.text([4.5, yf, 5.55], "profile", "tx", { size: 10 });
				s.text([4.5, yf, 0.6], "note", "tx", { size: 10 });
			});
			s.group([4.5, 6.5, 3], () => {
				s.box(2.3, 5, 2.2, 4.4, 3.4, 1.6, "hi");
				s.line([4, 8.41, 3.2], [5, 8.41, 3.2], "hi");
				s.text([4.5, 8.41, 2.45], "log", "tx hi", { size: 10 });
			});
			[5.6, 6.4, 7.2].forEach((y, i) => {
				s.anim(`mc${i}`, () => {
					s.group([4.5, y, 4.2 + i * 0.01], () => {
						s.box(2.8, y, 3.8, 3.4, 0.12, 1.1 - i * 0.2, "sil");
					});
				});
			});
		},
		motion: (m) => m.chase("mc", 3, 4.5, { lift: [0, 0, 1.3] }),
	},
	"open-pr": {
		kind: "extension",
		desc: "Opens the current branch's pull request in your browser.",
		draw(s) {
			s.plate(0, 0, 14, 9);
			s.line([0.8, 6.5, 0.01], [9.2, 6.5, 0.01], "");
			const branch = [
				[2.6, 6.5, 0.01],
				[3.6, 4.2, 0.01],
				[7.2, 4.2, 0.01],
				[8.4, 6.5, 0.01],
			];
			s.path(branch, "lo");
			s.anim("bp", () => s.path(branch, "hi"), { draw: true });
			for (const x of [1.4, 4.8]) s.cyl(x, 6.5, 0, 0.35, 0.3, "sil");
			for (const x of [4.4, 6.2]) s.cyl(x, 4.2, 0, 0.35, 0.3, "hi");
			s.cyl(8.4, 6.5, 0, 0.45, 0.4, "hi", { top: "hi" });
			s.arrow([8.8, 6.3, 0.6], [10.4, 4.6, 2.2], "hi dash march");
			windowPanel(s, 9.6, 1, 0.15, 4, 5.2, {
				content(yf) {
					s.anim("pw", () => {
						s.text([10.2, yf, 3.9], "PR", "tx hi", { anchor: "start", size: 14 });
						barsXZ(s, 10.2, yf, 3.1, [2.6, 2.0, 2.8], 0.6);
					});
				},
			});
		},
		motion: (m) => m.drawIn("bp", 4.5, 5, 45) + m.appear("pw", 4.5, 50),
	},
	"setup-sh": {
		kind: "extension",
		desc: "Runs the repo's setup.sh when a session starts, and skips it once it passed.",
		draw(s) {
			s.plate(0, 0, 13, 9);
			s.group([4, 5, 1.3], () => {
				s.box(1.5, 3, 0, 5, 4, 2.4, "sil");
				s.box(1.5, 3, 2.4, 2, 4, 0.35, "sil");
			});
			s.anim("ss", () => {
				s.group([4, 5, 5], () => {
					s.box(2.6, 4, 4.6, 2.8, 2, 0.12, "hi");
					s.text([4, 5, 4.73], "setup.sh", "tx hi", { size: 10 });
				});
			});
			s.arrow([4, 5, 4.4], [4, 5, 3.0], "dash march");
			windowPanel(s, 8, 1.5, 0.15, 4.4, 5, {
				content(yf) {
					[3.4, 2.5, 1.6].forEach((z, i) => {
						const done = i < 2;
						if (done) s.anim(`sc${i}`, () => s.path(check(8.4, yf, z), "hi"));
						else s.circle([8.65, yf, z], X, Z, 0.16, "", { fill: false });
						s.line([9.4, yf, z], [9.4 + [2.2, 1.6, 2.6][i], yf, z], done ? "hi" : "");
					});
				},
			});
		},
		motion: (m) =>
			m.travel("ss", 5, [
				[0, [0, 0, 0.8], 0],
				[12, [0, 0, 0], 1],
				[35, [0, 0, 0], 1],
				[48, [0, 0, -1.4], 0],
				[100, [0, 0, -1.4], 0],
			]) +
			m.appear("sc0", 5, 50) +
			m.appear("sc1", 5, 65),
	},
	subagent: {
		kind: "extension",
		desc: "Delegates work to async subagents with run, batch, chain, and continue.",
		draw(s) {
			s.plate(0, 0, 13, 11);
			s.box(4.6, 0.8, 0, 3.6, 3, 2.4, "hi");
			s.text([6.4, 2.3, 3.2], "main", "tx hi");
			const kids = [
				[1, "scout"],
				[5, "worker"],
				[9, "reviewer"],
			];
			kids.forEach(([x, name], i) => {
				s.path(
					[
						[6.4, 3.9, 0.01],
						[6.4, 5.2, 0.01],
						[x + 1.4, 5.2, 0.01],
						[x + 1.4, 6.6, 0.01],
					],
					"dash march",
				);
				s.group([x + 1.4, 7.8, 0.8], () => {
					s.box(x, 6.8, 0, 2.8, 2.2, 1.4, "sil");
					for (let j = 0; j < 3; j++) {
						s.circle([x + 0.7 + j * 0.7, 9.01, 0.7], X, Z, 0.14, "");
						s.anim(`sd${i}${j}`, () => s.circle([x + 0.7 + j * 0.7, 9.01, 0.7], X, Z, 0.14, "hi"));
					}
				});
				s.text([x + 1.4, 7.9, 2.0], name, "tx");
			});
			s.arrow([11.8, 6.6, 1.6], [8.4, 2.6, 2.0], "hi");
			s.anim("sr", () => s.dot([11.8, 6.6, 1.6], "dot", 3.4));
		},
		motion: (m) => {
			let css = "";
			for (let i = 0; i < 3; i++) {
				for (let j = 0; j < 3; j++) css += m.appear(`sd${i}${j}`, 6, 8 + j * (14 + i * 8));
			}
			return (
				css +
				m.travel(
					"sr",
					6,
					[
						[0, [0, 0, 0], 0],
						[68, [0, 0, 0], 0],
						[72, [0, 0, 0], 1],
						[88, [-3.4, -4, 0.4], 1],
						[94, [-3.4, -4, 0.4], 0],
						[100, [-3.4, -4, 0.4], 0],
					],
					{ hidden: true },
				)
			);
		},
	},
	task: {
		kind: "extension",
		desc: "Keeps a persistent RPC worker per task, routed to a fast, balanced, or powerful model.",
		draw(s) {
			s.plate(0, 0, 14, 10);
			s.box(0.8, 3.4, 0, 3.2, 3, 2.6, "sil");
			s.text([2.4, 4.9, 3.4], "parent", "tx");
			s.arrow([4.2, 4.4, 1.9], [9.2, 4.4, 1.9], "hi");
			s.arrow([9.2, 5.6, 0.9], [4.2, 5.6, 0.9], "dash march");
			s.text([6.7, 4.4, 2.5], "edit", "tx hi");
			s.text([6.7, 5.6, 0.25], "report", "tx");
			s.anim("te", () => s.dot([4.4, 4.4, 1.9], "dot", 3.4));
			s.box(9.4, 3.4, 0, 3.2, 3, 2.6, "hi");
			s.cyl(11, 8.2, 0, 0.6, 1.2, "sil");
			s.line([11, 6.5, 0.6], [11, 7.6, 0.6], "dash");
			s.dot([11, 4.9, 3.4], "dot");
			const models = [
				["fast", 8.2],
				["balanced", 11],
				["powerful", 13.8],
			];
			models.forEach(([name, x], i) => {
				const route = [
					[11, 4.9, 3.4],
					[11, 4.9, 4.4],
					[x, 1, 4.4],
				];
				s.path(route, "lo");
				if (i === 1) s.anim("tr", () => s.path(route, "hi"), { draw: true });
				s.box(x - 0.6, 0.4, 4.4, 1.2, 1.2, 0.4, i === 1 ? "hi" : "sil");
				s.text([x, 1, 5.5], name, i === 1 ? "tx hi" : "tx", { size: 10 });
			});
		},
		motion: (m) =>
			m.travel(
				"te",
				4,
				[
					[0, [0, 0, 0], 0],
					[5, [0, 0, 0], 1],
					[30, [4.6, 0, 0], 1],
					[35, [4.6, 0, 0], 0],
					[100, [4.6, 0, 0], 0],
				],
				{ hidden: true },
			) + m.drawIn("tr", 4, 35, 60),
	},
	"todo-write-overlay": {
		kind: "extension",
		desc: "Shows the agent's live task list in a top-right overlay.",
		draw(s) {
			s.plate(0, 0, 13, 6);
			windowPanel(s, 0.8, 2.2, 0.15, 11.4, 7, {
				content(yf) {
					barsXZ(s, 1.4, yf, 5.4, [4.2, 3.4, 5.0, 2.8, 4.4, 3.0, 3.8], 0.65, "lo");
				},
			});
			s.group([9.6, 2.9, 4.3], () => {
				s.box(7.6, 2.5, 1.9, 4, 0.7, 4.6, "hi");
				const yf = 3.21;
				["done", "done", "doing", "todo"].forEach((st, i) => {
					const z = 5.6 - i * 1;
					s.poly(rectXZ(8.1, 8.55, yf, z - 0.22, z + 0.22), st === "todo" ? "" : "hi", { fill: false });
					if (st === "done") {
						s.anim(`tc${i}`, () => {
							s.path(
								[
									[8.17, yf, z],
									[8.3, yf, z - 0.13],
									[8.5, yf, z + 0.16],
								],
								"hi",
							);
						});
					}
					if (st === "doing") s.anim("td", () => s.circle([8.325, yf, z], X, Z, 0.08, "hi"));
					const w = [2.2, 1.6, 2.4, 1.8][i];
					s.line([8.9, yf, z], [8.9 + w, yf, z], st === "todo" ? "" : st === "doing" ? "hi" : "lo");
				});
			});
		},
		motion: (m) => m.appear("tc0", 4, 12) + m.appear("tc1", 4, 32) + m.blink("td", 1),
	},
	until: {
		kind: "extension",
		desc: "Re-runs a prompt on an interval until a condition, like a green PR, is met.",
		draw(s) {
			s.disk(0, 0, 0, 5.6, "sil", { layer: -1 });
			s.circle([0, 0, 0.01], X, Y, 4.4, "", { fill: false });
			s.circle([0, 0, 0.01], X, Y, 3.0, "", { fill: false });
			for (let i = 0; i < 6; i++) {
				const a = (i / 6) * Math.PI * 2 + 0.5;
				const p = (r, da) => [Math.cos(a + da) * r, Math.sin(a + da) * r, 0.02];
				s.path([p(4.0, -0.08), p(3.7, 0.04), p(3.4, -0.08)], "lo");
			}
			for (let i = 0; i < 6; i++) {
				const a = (i / 6) * Math.PI * 2;
				const cx = Math.cos(a) * 3.7;
				const cy = Math.sin(a) * 3.7;
				s.anim(`lap${i}`, () => {
					s.box(cx - 0.7, cy - 0.7, 0, 1.4, 1.4, 1.0, "hi");
					s.text([-3.2, -3.2, 0.2], `0${i + 1}`, "tx hi", { size: 13 });
				});
			}
			const flag = [
				[0, 3.6, 3.6],
				[1.6, 3.6, 3.2],
				[0, 3.6, 2.8],
			];
			s.box(-0.4, 3.2, 0, 0.8, 0.8, 0.3, "sil");
			s.line([0, 3.6, 0.3], [0, 3.6, 3.6], "");
			s.poly(flag, "");
			s.anim("lap5", () => {
				s.line([0, 3.6, 0.3], [0, 3.6, 3.6], "hi");
				s.poly(flag, "hi");
			});
		},
		motion: (m) => m.slots("lap", 6, 6),
	},
	"vcc-ko": {
		kind: "extension",
		desc: "Compacts long chats without an LLM call, Korean-aware, with session_recall search.",
		draw(s) {
			s.plate(0, 0, 14, 8);
			for (let i = 0; i < 10; i++) s.box(1, 2, i * 0.45, 4, 4, 0.2, i === 9 ? "hi" : "sil");
			s.arrow([5.6, 4, 2.2], [7.6, 4, 1.2], "hi dash march");
			s.group([10, 4, 0.8], () => {
				s.box(8, 2, 0, 4, 4, 1.2, "hi");
				barsTop(s, 8.5, 2.7, 1.21, [2.6, 3.0, 2.0, 2.6], 0.75, "");
			});
			s.anim("vs", () => s.box(1.6, 2.6, 4.3, 2.8, 2.8, 0.1, "hi"), { layer: 3 });
			const c = [11.6, 5.6, 3.6];
			s.anim("mg", () => {
				s.group(c, () => {
					s.circle(c, X, Z, 1.1, "sil", { fill: false });
					s.circle(c, X, Z, 0.85, "lo", { fill: false });
				});
				s.line([12.4, 5.6, 2.8], [13.4, 5.6, 1.8], "hi");
				s.text([12.4, 5.6, 5.4], "recall", "tx hi");
			});
		},
		motion: (m) =>
			m.travel(
				"vs",
				4,
				[
					[0, [0, 0, 0.6], 0],
					[10, [0, 0, 0], 1],
					[55, [6.8, 0, -2.9], 1],
					[65, [6.8, 0, -2.9], 0],
					[100, [6.8, 0, -2.9], 0],
				],
				{ hidden: true },
			) + m.float("mg", 4, [-2.6, 0, 0]),
	},
	"web-access": {
		kind: "extension",
		desc: "Searches the web and pulls pages, PDFs, GitHub, and YouTube into context.",
		draw(s) {
			s.plate(0, 0, 13, 11);
			const globe = [4, 3, 3.6];
			s.sphere(globe, 3.0, "sil");
			for (let f = 0; f < 4; f++) s.anim(`wg${f}`, () => s.meridians(globe, 3.0, (f / 4) * (Math.PI / 4)));
			const cards = [
				["page", 8.4, 2.2],
				["pdf", 8.6, 6.4],
				["repo", 4.4, 7.8],
			];
			cards.forEach(([name, x, y], i) => {
				s.line([4.6, 4.2, 1.2], [x + 0.4, y + 0.4, 0.35], "dash");
				s.group([x + 1.4, y + 1, 0.4], () => {
					s.box(x, y, 0.2, 3, 2.2, 0.14, i === 0 ? "hi" : "sil");
					barsTop(s, x + 0.4, y + 0.6, 0.35, [2.0, 1.4, 1.8], 0.5, "");
				});
				s.text([x + 1.5, y + 1.1, 1.3], name, i === 0 ? "tx hi" : "tx", { size: 11 });
				s.anim(`wp${i}`, () => s.dot([4.6, 4.2, 1.2], "dot", 3));
			});
		},
		motion: (m) =>
			m.slots("wg", 4, 1.6) +
			[
				[8.4, 2.2],
				[8.6, 6.4],
				[4.4, 7.8],
			]
				.map(([x, y], i) => {
					const end = [x + 0.4 - 4.6, y + 0.4 - 4.2, 0.35 - 1.2];
					return m.travel(
						`wp${i}`,
						3,
						[
							[0, [0, 0, 0], 0],
							[8, [0, 0, 0], 1],
							[55, end, 1],
							[65, end, 0],
							[100, end, 0],
						],
						{ hidden: true, delay: i, ease: "ease-in-out" },
					);
				})
				.join(""),
	},
	a4: {
		kind: "skill",
		desc: "Converts Markdown into an A4 Word document without touching the words.",
		draw(s) {
			s.plate(0, 0, 13, 8);
			s.group([2.6, 4.6, 0.2], () => {
				s.box(0.8, 3, 0, 3.6, 3.4, 0.16, "sil");
				s.text([1.2, 3.8, 0.17], "#", "tx hi", { anchor: "start", size: 13 });
				barsTop(s, 1.7, 3.6, 0.17, [2.2], 0.6, "hi");
				barsTop(s, 1.2, 4.4, 0.17, [2.8, 2.2, 2.6], 0.55, "");
			});
			s.arrow([4.8, 4.6, 0.6], [6.4, 4.6, 0.6], "hi");
			s.anim("ap", () => s.box(3.4, 4.2, 0.5, 1.0, 0.8, 0.06, "hi"), { layer: 3 });
			[0, 1, 2].forEach((i) => {
				const x = 7 + i * 0.9;
				const y = 2 + i * 0.9;
				s.group([x + 2, y, 3], () => {
					s.box(x, y, 0.15, 4.2, 0.12, 5.94, i === 2 ? "hi" : "sil");
					if (i === 2) {
						const yf = y + 0.13;
						s.poly(rectXZ(x + 0.5, x + 3.7, yf, 0.65, 5.6), "lo dash", { fill: false });
						[2.4, 2.6, 2.0, 2.6, 1.6].forEach((w, j) => {
							const z = 5.1 - j * 0.6;
							s.anim(`ad${j}`, () => s.line([x + 0.8, yf, z], [x + 0.8 + w, yf, z], ""), { draw: true });
						});
						s.text([x + 3.5, yf, 0.85], "A4", "tx", { anchor: "end", size: 10 });
					}
				});
			});
		},
		motion: (m) =>
			m.travel(
				"ap",
				5,
				[
					[0, [0, 0, 0], 0],
					[6, [0, 0, 0], 1],
					[24, [3.4, 0, 0.2], 1],
					[30, [3.4, 0, 0.2], 0],
					[100, [3.4, 0, 0.2], 0],
				],
				{ hidden: true },
			) + [0, 1, 2, 3, 4].map((j) => m.drawIn(`ad${j}`, 5, 28 + j * 9, 38 + j * 9)).join(""),
	},
	"chrome-cdp": {
		kind: "skill",
		desc: "Inspects and drives your real, logged-in Chrome through DevTools Protocol.",
		draw(s) {
			s.plate(0, 0, 13, 10);
			[1.6, 3.6].forEach((x, i) => {
				s.box(x, 2, 6.1, 1.8, 0.3, 0.45, i === 0 ? "hi" : "sil");
			});
			windowPanel(s, 1.2, 2, 0.15, 8.6, 5.9, {
				content(yf) {
					s.poly(rectXZ(1.8, 5, yf, 3.4, 4.9), "", { fill: false });
					s.anim("ch", () => s.poly(rectXZ(1.7, 5.1, yf, 3.3, 5.0), "hi dash", { fill: false }));
					barsXZ(s, 5.6, yf, 4.7, [3.4, 2.6, 3.0], 0.6);
					barsXZ(s, 1.8, yf, 2.6, [7.2, 6.0, 6.6], 0.6, "lo");
				},
			});
			const cablePt = (t) => [9.8 + t * 1.2, 2.2 + t * 4.8, 3 * (1 - t) ** 2 + 0.6 * t];
			const cable = [];
			for (let i = 0; i <= 20; i++) cable.push(cablePt(i / 20));
			s.path(cable, "hi");
			for (let i = 0; i < 4; i++) s.anim(`cd${i}`, () => s.dot(cablePt(1 - (i + 1) / 5), "dot", 3));
			s.group([11, 8, 0.6], () => {
				s.box(9.8, 7, 0, 2.4, 2, 0.9, "hi");
				[10.4, 11, 11.6].forEach((x, i) => {
					s.disk(x, 8, 0.91, 0.18, i === 0 ? "hi" : "");
				});
			});
			s.text([11, 8, 1.9], "CDP", "tx hi");
		},
		motion: (m) => m.slots("cd", 4, 1.2) + m.twinkle("ch", 1.6, 0),
	},
	excalidraw: {
		kind: "skill",
		desc: "Writes .excalidraw diagrams and opens them in a live-synced local window.",
		draw(s) {
			s.plate(0, 0, 13, 10);
			const jitter = (pts, amp, seed) =>
				pts.map(([x, y, z], i) => [x + Math.sin(i * 12.9 + seed) * amp, y + Math.cos(i * 7.1 + seed) * amp, z]);
			const rough = (pts, cls) => {
				s.path(jitter([...pts, pts[0]], 0.06, 1), cls);
				s.path(jitter([...pts, pts[0]], 0.08, 5), cls);
			};
			const z = 0.17;
			s.group([5, 5.9, 0.08], () => {
				s.box(0.8, 2.6, 0, 8.4, 6.6, 0.16, "sil");
				const strokes = [
					() =>
						rough(
							[
								[1.6, 3.4, z],
								[4, 3.4, z],
								[4, 5, z],
								[1.6, 5, z],
							],
							"hi",
						),
					() => {
						s.path(
							jitter(
								[
									[4.1, 4.2, z],
									[5.4, 4.2, z],
								],
								0.04,
								2,
							),
							"hi",
						);
						s.path(
							[
								[5.1, 4.0, z],
								[5.45, 4.2, z],
								[5.1, 4.4, z],
							],
							"hi",
						);
					},
					() => rough(s.circlePts([6.8, 4.2, z], X, Y, 1.3, 18).slice(0, -1), ""),
					() =>
						s.path(
							jitter(
								[
									[2.8, 5.1, z],
									[2.8, 6.3, z],
								],
								0.04,
								3,
							),
							"",
						),
					() =>
						rough(
							[
								[2.8, 6.4, z],
								[4, 7.4, z],
								[2.8, 8.4, z],
								[1.6, 7.4, z],
							],
							"",
						),
					() =>
						s.path(
							jitter(
								[
									[6.8, 5.6, z],
									[6.8, 7.4, z],
									[4.2, 7.4, z],
								],
								0.04,
								4,
							),
							"",
						),
				];
				strokes.forEach((draw, i) => {
					s.anim(`ex${i}`, draw, { draw: true });
				});
			});
			windowPanel(s, 9.8, 1, 0.15, 3.2, 3.6, {
				content(yf) {
					s.anim("el", () => {
						s.poly(rectXZ(10.2, 11.1, yf, 1.6, 2.3), "hi", { fill: false });
						s.circle([12.2, yf, 1.95], X, Z, 0.4, "", { fill: false });
						s.line([11.15, yf, 1.95], [11.8, yf, 1.95], "hi");
					});
				},
			});
			s.arrow([9.2, 4.8, 0.4], [10.4, 2.3, 1.2], "dash march");
			s.text([11.4, 1.3, 4.6], "live", "tx hi");
		},
		motion: (m) =>
			[0, 1, 2, 3, 4, 5].map((i) => m.drawIn(`ex${i}`, 6, 4 + i * 9, 13 + i * 9)).join("") + m.appear("el", 6, 66),
	},
	hairline: {
		kind: "skill",
		desc: "Adds hairline's pointer-reactive isometric line figures to web pages.",
		draw(s) {
			s.plate(-0.4, -0.4, 9.8, 9.8, 0, 0.3);
			const frames = 6;
			for (let f = 0; f < frames; f++) {
				const a = (f / frames) * Math.PI * 2;
				const px = 4 + 2 * Math.cos(a);
				const py = 4 + 2 * Math.sin(a);
				s.anim(
					`hf${f}`,
					() => {
						for (let i = 0; i < 9; i++) {
							for (let j = 0; j < 9; j++) {
								const d = Math.hypot(i - px, j - py);
								const h = 0.25 + 3.2 * Math.exp(-(d * d) / 5);
								s.box(i, j, 0, 0.8, 0.8, h, d < 1.3 ? "hi" : "sil");
							}
						}
						s.text([px + 0.4, py + 0.4, 5.2], "↖", "tx hi", { anchor: "start", size: 24 });
					},
					{ layer: f * 0.01 },
				);
			}
		},
		motion: (m) => m.slots("hf", 6, 3),
	},
	"skill-creator": {
		kind: "skill",
		desc: "Creates, edits, and validates Agent Skills: triggers, SKILL.md, references.",
		draw(s) {
			s.plate(0, 0, 13, 10);
			[
				["scripts/", 9.6, 1.4],
				["references/", 7.2, 2.6],
			].forEach(([name, x, y], i) => {
				s.anim(`ks${i}`, () => {
					s.group([x + 1.6, y, 2.6], () => {
						s.box(x, y, 0.15, 3.2, 0.15, 4.2, "sil");
						barsXZ(s, x + 0.4, y + 0.16, 3.4, [2.2, 1.6, 2.0, 1.2], 0.6, "lo");
					});
					s.text([x + 1.6, y, 4.9], name, "tx", { size: 10 });
				});
			});
			s.group([3.6, 5.6, 3], () => {
				s.box(1.6, 5, 0.15, 4, 0.2, 5.6, "hi");
				const yf = 5.21;
				s.poly(rectXZ(2, 5.2, yf, 4.2, 5.3), "hi", { fill: false });
				s.line([2.3, yf, 4.95], [4.4, yf, 4.95], "hi");
				s.line([2.3, yf, 4.55], [4.8, yf, 4.55], "");
				[2.6, 3.0, 2.2, 2.8, 1.8].forEach((w, j) => {
					const z = 3.4 - j * 0.55;
					s.anim(`kd${j}`, () => s.line([2.2, yf, z], [2.2 + w, yf, z], ""), { draw: true });
				});
			});
			s.text([3.6, 5.6, 6.4], "SKILL.md", "tx hi", { size: 11 });
			s.path(
				[
					[5.6, 5.4, 2.2],
					[7.2, 3.4, 2.2],
				],
				"dash march",
			);
			s.path(
				[
					[5.6, 5.4, 1.4],
					[9.6, 2.2, 1.4],
				],
				"dash march",
			);
		},
		motion: (m) =>
			[0, 1, 2, 3, 4].map((j) => m.drawIn(`kd${j}`, 5, 5 + j * 10, 15 + j * 10)).join("") +
			m.float("ks0", 3, [0, 0, 0.5]) +
			m.float("ks1", 3, [0, 0, 0.5], 1.5),
	},
	"tmux-terminal": {
		kind: "skill",
		desc: "Drives TUIs, REPLs, and stdin programs through an isolated tmux pane.",
		draw(s) {
			s.plate(0, 0, 13, 10);
			windowPanel(s, 1, 1.6, 0.15, 11, 5.8, {
				content(yf) {
					s.line([6.5, yf, 0.4], [6.5, yf, 5.1], "");
					s.line([6.5, yf, 2.8], [11.7, yf, 2.8], "");
					s.text([1.5, yf, 4.4], ">>>", "tx hi", { anchor: "start", size: 10 });
					s.anim("tp", () => s.line([2.6, yf, 4.5], [5.2, yf, 4.5], "hi"), { draw: true });
					barsXZ(s, 1.5, yf, 3.7, [4.2, 3.4, 4.6, 2.4], 0.6, "lo");
					barsXZ(s, 7, yf, 4.5, [3.6, 2.6], 0.6, "lo");
					s.anim("tc", () => s.poly(rectXZ(7, 7.3, yf, 1.2, 1.7), "hi"));
				},
			});
			["^C", "↵", "q", "↑", "esc"].forEach((key, i) => {
				const x = 2.4 + i * 1.7;
				s.anim(`tk${i}`, () => {
					s.group([x + 0.7, 8.3, 0.3], () => {
						s.box(x, 7.6, 0, 1.4, 1.4, 0.6, "sil");
					});
					s.text([x + 0.7, 8.3, 0.65], key, "tx", { size: 10 });
				});
			});
			s.arrow([4.8, 7.6, 0.8], [7.15, 1.9, 1.4], "hi dash march");
		},
		motion: (m) => m.chase("tk", 5, 3, { lift: [0, 0, -0.3] }) + m.drawIn("tp", 3, 5, 45) + m.blink("tc", 1),
	},
};

// skill-* package directories use the short skill name
const packageDir = (name) => (SCENES[name].kind === "skill" ? `skill-${name}` : name);

const written = [];
for (const [name, scene] of Object.entries(SCENES)) {
	const s = createScene();
	scene.draw(s);
	const { body, k } = renderScene(s);
	const svg = svgDoc(name, scene.kind, scene.desc, body, scene.motion(motionKit(k)));
	const file = join(ROOT, "packages", packageDir(name), "cover.svg");
	writeFileSync(file, svg);
	written.push({ name, file });
}
process.stdout.write(`wrote ${written.length} cover.svg files under packages/\n`);

if (process.argv.includes("--preview")) {
	const cards = written.map((w) => `<img src="file://${w.file}" width="360" alt="${w.name}">`).join("\n");
	const html = `<!doctype html><meta charset="utf-8"><title>package art</title>
<style>body{margin:24px;font-family:system-ui;background:#f6f6f7}body.d{background:#000}
.grid{display:grid;grid-template-columns:repeat(auto-fill,360px);gap:16px}</style>
<p><button onclick="document.body.classList.toggle('d')">bg</button> SVG theme follows the OS color scheme.</p>
<div class="grid">${cards}</div>`;
	const preview = join(tmpdir(), "pi-extension-package-art.html");
	writeFileSync(preview, html);
	process.stdout.write(`preview: ${preview}\n`);
}
