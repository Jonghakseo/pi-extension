#!/usr/bin/env node
// excal: open .excalidraw files in a live-synced local Excalidraw window,
// inspect/lint them, and take PNG snapshots for visual self-checks.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	APP_DIR,
	CHROME_PROFILE_DIR,
	DIST_DIR,
	emptyScene,
	ensureStateDir,
	fileIdFor,
	HISTORY_DIR,
	LOG_FILE,
	readJSON,
	readToken,
	realPathOf,
	SKILL_DIR,
	SNAPSHOT_DIR,
	STATE_FILE,
	writeFileAtomic,
} from "./lib.mjs";

const USAGE = `usage:
  excal open <file.excalidraw> [--from-mermaid <file.mmd>] [--no-window]
  excal inspect <file.excalidraw>
  excal lint <file.excalidraw>
  excal snapshot <file.excalidraw> [-o out.png]
  excal history <file.excalidraw>
  excal status | stop | build`;

const die = (msg, code = 1) => {
	console.error(msg);
	process.exit(code);
};

// ---------- build / server ----------

function ensureBuilt(force = false) {
	if (!force && fs.existsSync(path.join(DIST_DIR, "index.html"))) return;
	const pm = spawnSync("pnpm", ["--version"]).status === 0 ? "pnpm" : "npm";
	if (!fs.existsSync(path.join(APP_DIR, "node_modules"))) {
		console.error(`[excal] 첫 실행: ${pm} install (1회만)`);
		const run = (args) => spawnSync(pm, args, { cwd: APP_DIR, stdio: ["ignore", 2, 2] });
		// In the source repo app/ sits inside a pnpm workspace without being a member, so a plain
		// `pnpm install` installs the workspace instead and leaves app/node_modules empty.
		const pnpmArgs = ["install", "--ignore-workspace"];
		let r = run(pm === "pnpm" ? [...pnpmArgs, "--frozen-lockfile"] : ["install"]);
		if (r.status !== 0 && pm === "pnpm") {
			console.error("[excal] frozen-lockfile 설치 실패(잠금 파일 불일치). 잠금 파일을 갱신해 재시도합니다");
			r = run(pnpmArgs);
		}
		if (r.status !== 0) die("[excal] install 실패");
	}
	console.error("[excal] 앱 빌드 중");
	const r = spawnSync(pm, ["run", "build"], { cwd: APP_DIR, stdio: ["ignore", 2, 2] });
	if (r.status !== 0) die("[excal] build 실패");
}

async function call(port, token, pathname, init = {}) {
	return fetch(`http://127.0.0.1:${port}${pathname}`, {
		...init,
		headers: { "x-excal-token": token, "content-type": "application/json", ...(init.headers || {}) },
	});
}

async function healthy(state, token) {
	if (!state?.port) return false;
	try {
		const r = await call(state.port, token, "/api/health", { signal: AbortSignal.timeout(1000) });
		return r.ok;
	} catch {
		return false;
	}
}

async function ensureServer() {
	ensureStateDir();
	ensureBuilt();
	const token = readToken();
	let state = readJSON(STATE_FILE, null);
	if (await healthy(state, token)) return { port: state.port, token };
	const log = fs.openSync(LOG_FILE, "a");
	spawn(process.execPath, [path.join(SKILL_DIR, "scripts", "server.mjs")], {
		detached: true,
		stdio: ["ignore", log, log],
	}).unref();
	for (let i = 0; i < 50; i++) {
		await new Promise((r) => setTimeout(r, 200));
		state = readJSON(STATE_FILE, null);
		if (await healthy(state, token)) return { port: state.port, token };
	}
	die(`[excal] 서버 시작 실패. 로그: ${LOG_FILE}`);
}

async function register(srv, file) {
	const r = await call(srv.port, srv.token, "/api/files", { method: "POST", body: JSON.stringify({ path: file }) });
	if (!r.ok) die(`[excal] 파일 등록 실패: ${await r.text()}`);
	return r.json();
}

function chromeCommand(url) {
	const args = [
		`--app=${url}`,
		`--user-data-dir=${CHROME_PROFILE_DIR}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1440,960",
		...(process.env.EXCAL_CHROME_ARGS ? process.env.EXCAL_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
	];
	if (process.platform === "darwin") {
		// `open -na` succeeds silently even when the app is missing, so probe first.
		if (spawnSync("open", ["-Ra", "Google Chrome"]).status !== 0) return null;
		return ["open", ["-na", "Google Chrome", "--args", ...args]];
	}
	for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
		if (spawnSync("which", [bin]).status === 0) return [bin, args];
	}
	return null;
}

/** @returns {"opened"|"not-connected"|"no-browser"|"browser-disabled"} */
async function openWindow(srv, info) {
	if (process.env.EXCAL_BROWSER === "none") return "browser-disabled";
	const cmd = chromeCommand(info.url);
	if (!cmd) {
		console.error(
			`[excal] Chrome을 찾지 못했습니다. references/setup.md의 설치 방법을 사용자에게 안내하세요. 직접 열려면: ${info.url}`,
		);
		return "no-browser";
	}
	spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
	return (await waitForClient(srv, info.id, 20_000)) ? "opened" : "not-connected";
}

async function waitForClient(srv, id, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const st = await (await call(srv.port, srv.token, "/api/status")).json();
		if (st.files.find((f) => f.id === id)?.clients > 0) return true;
		await new Promise((r) => setTimeout(r, 250));
	}
	return false;
}

function resolveFile(p, { create = false } = {}) {
	if (!p) die(USAGE);
	const abs = path.resolve(p);
	if (!fs.existsSync(abs)) {
		if (!create) die(`[excal] 파일이 없습니다: ${abs}`);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, emptyScene());
	}
	return realPathOf(abs);
}

// ---------- scene analysis (inspect / lint) ----------

function loadScene(file) {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		return { error: `JSON 파싱 실패: ${err.message}` };
	}
	const elements = (Array.isArray(data.elements) ? data.elements : []).filter((e) => !e.isDeleted);
	return { data, elements };
}

const isSkel = (e) => typeof e.version !== "number";
const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const LINEAR = new Set(["arrow", "line"]);
const round = (n) => (typeof n === "number" ? Math.round(n) : "?");

function textWidthEstimate(text, fontSize = 20) {
	let max = 0;
	for (const line of String(text).split("\n")) {
		let w = 0;
		for (const ch of line)
			w += /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.55;
		max = Math.max(max, w);
	}
	return max;
}

/** Bounding box of an element, estimating text size the window has not measured yet. */
function measuredBox(e) {
	if (typeof e.x !== "number" || typeof e.y !== "number") return null;
	const text = String(e.text ?? "");
	const fontSize = e.fontSize ?? 20;
	const w =
		typeof e.width === "number" ? Math.abs(e.width) : e.type === "text" ? textWidthEstimate(text, fontSize) : undefined;
	const h =
		typeof e.height === "number"
			? Math.abs(e.height)
			: e.type === "text"
				? fontSize * 1.25 * text.split("\n").length
				: undefined;
	if (w === undefined && h === undefined) return null;
	return { x: e.x, y: e.y, w: w ?? 0, h: h ?? 0 };
}

function labelOf(el, byId) {
	if (el.label?.text) return el.label.text;
	if (el.type === "text") return el.text;
	const bound = (el.boundElements || []).find((b) => b.type === "text");
	return bound ? byId.get(bound.id)?.text : undefined;
}

function arrowEnds(el) {
	const s = el.start?.id ?? el.startBinding?.elementId;
	const e = el.end?.id ?? el.endBinding?.elementId;
	return [s, e];
}

function inspect(file) {
	const { error, elements } = loadScene(file);
	if (error) die(error);
	const byId = new Map(elements.map((e) => [e.id, e]));
	const visible = elements.filter((e) => !(e.type === "text" && e.containerId));
	const count = (pred) => visible.filter(pred).length;
	const boxes = visible.map(measuredBox).filter(Boolean);
	const minX = Math.min(...boxes.map((b) => b.x));
	const minY = Math.min(...boxes.map((b) => b.y));
	const maxX = Math.max(...boxes.map((b) => b.x + b.w));
	const maxY = Math.max(...boxes.map((b) => b.y + b.h));
	console.log(
		`${path.basename(file)}  요소 ${visible.length}개 (도형 ${count((e) => SHAPES.has(e.type))}, 화살표/선 ${count((e) => LINEAR.has(e.type))}, 텍스트 ${count((e) => e.type === "text")})` +
			(boxes.length ? `  범위 x ${round(minX)}~${round(maxX)}, y ${round(minY)}~${round(maxY)}` : "") +
			(elements.some(isSkel) ? "  [스켈레톤 포함: 창에서 열면 정규화됨]" : ""),
	);
	for (const el of visible) {
		const label = labelOf(el, byId);
		const lbl = label ? `  "${label.replace(/\n/g, "\\n")}"` : "";
		const style = [
			el.backgroundColor && el.backgroundColor !== "transparent" ? `bg=${el.backgroundColor}` : "",
			el.strokeColor && el.strokeColor !== "#1e1e1e" ? `stroke=${el.strokeColor}` : "",
		]
			.filter(Boolean)
			.join(" ");
		if (LINEAR.has(el.type)) {
			const [s, e] = arrowEnds(el);
			console.log(
				`[${el.type}] ${el.id}  ${s ?? "·"} → ${e ?? "·"}${lbl}  @(${round(el.x)},${round(el.y)})${style ? "  " + style : ""}`,
			);
		} else {
			console.log(
				`[${el.type}] ${el.id}  @(${round(el.x)},${round(el.y)} ${round(el.width)}×${round(el.height)})${lbl}${style ? "  " + style : ""}${el.frameId ? `  frame=${el.frameId}` : ""}`,
			);
		}
	}
}

function lint(file) {
	const { error, data, elements } = loadScene(file);
	const errors = [];
	const warns = [];
	if (error) errors.push(error);
	else {
		if (data.type !== "excalidraw") errors.push(`최상위 type이 "excalidraw"가 아닙니다: ${data.type}`);
		if (!Array.isArray(data.elements)) errors.push("최상위 elements 배열이 없습니다");
		const all = Array.isArray(data.elements) ? data.elements : [];
		const ids = new Map();
		for (const e of all) {
			if (!e.type) errors.push(`type 없는 요소: ${JSON.stringify(e).slice(0, 80)}`);
			if (!e.id) {
				if (isSkel(e) && !LINEAR.has(e.type)) warns.push(`id 없는 ${e.type} 요소 (나중에 수정·연결하려면 id 권장)`);
				continue;
			}
			if (ids.has(e.id)) errors.push(`중복 id: ${e.id}`);
			ids.set(e.id, e);
		}
		const ref = (owner, id, what) => {
			if (id && !ids.has(id)) errors.push(`${owner.id ?? owner.type}의 ${what}가 없는 요소를 가리킴: ${id}`);
		};
		for (const e of elements) {
			ref(e, e.containerId, "containerId");
			ref(e, e.frameId, "frameId");
			for (const b of e.boundElements || []) ref(e, b.id, "boundElements");
			ref(e, e.startBinding?.elementId, "startBinding");
			ref(e, e.endBinding?.elementId, "endBinding");
			ref(e, e.start?.id, "start.id");
			ref(e, e.end?.id, "end.id");
			if (isSkel(e) && LINEAR.has(e.type)) {
				const [s, t] = arrowEnds(e);
				if (typeof e.x !== "number" && !(s && t))
					errors.push(`${e.id ?? "arrow"}: x/y도 없고 start.id·end.id도 없습니다`);
				if (typeof e.x !== "number" && s && t) {
					for (const id of [s, t]) {
						const target = ids.get(id);
						if (target && (typeof target.width !== "number" || typeof target.height !== "number"))
							errors.push(`${e.id ?? "arrow"}: 자동 연결 대상 ${id}에 width/height가 없습니다`);
					}
				}
			}
			if (isSkel(e) && SHAPES.has(e.type) && e.label?.text && typeof e.width === "number") {
				// Fonts render wider than the estimate; diamonds need extra room around their text.
				const fontSize = e.label.fontSize ?? 20;
				const scale = e.type === "diamond" ? 1.5 : 1;
				const needW = (textWidthEstimate(e.label.text, fontSize) + 48) * scale;
				const needH = (fontSize * 1.25 * e.label.text.split("\n").length + 32) * scale;
				if (needW > e.width || (typeof e.height === "number" && needH > e.height))
					warns.push(
						`${e.id}: 라벨 "${e.label.text.split("\n")[0]}"이 ${e.width}×${e.height}에 빠듯해 보임 (약 ${Math.round(needW)}×${Math.round(needH)}px 필요)`,
					);
			}
		}
		// partial overlaps between top-level boxes (containment is treated as intentional grouping)
		const boxes = elements
			.filter((e) => SHAPES.has(e.type) || (e.type === "text" && !e.containerId))
			.map((e) => {
				const b = measuredBox(e);
				return b && { id: e.id ?? e.type, x1: b.x, y1: b.y, x2: b.x + b.w, y2: b.y + b.h };
			})
			.filter(Boolean);
		const contains = (a, b) => a.x1 <= b.x1 && a.y1 <= b.y1 && a.x2 >= b.x2 && a.y2 >= b.y2;
		for (let i = 0; i < boxes.length; i++)
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i];
				const b = boxes[j];
				const ix = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
				const iy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
				if (ix > 2 && iy > 2 && !contains(a, b) && !contains(b, a))
					warns.push(`겹침: ${a.id} ↔ ${b.id} (${Math.round(ix)}×${Math.round(iy)})`);
			}
		for (const e of elements) {
			if (e.type !== "arrow") continue;
			const [s, t] = arrowEnds(e);
			if (!s || !t) warns.push(`${e.id ?? "arrow"}: 한쪽 이상이 도형에 연결되지 않은 화살표`);
		}
	}
	for (const m of errors) console.log(`ERROR ${m}`);
	for (const m of warns) console.log(`WARN  ${m}`);
	console.log(errors.length || warns.length ? `오류 ${errors.length}, 경고 ${warns.length}` : "OK");
	process.exit(errors.length ? 1 : 0);
}

// ---------- commands ----------

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
	const i = rest.indexOf(name);
	if (i === -1) return undefined;
	const v = rest[i + 1];
	rest.splice(i, 2);
	return v;
};
const bool = (name) => {
	const i = rest.indexOf(name);
	if (i === -1) return false;
	rest.splice(i, 1);
	return true;
};

switch (cmd) {
	case "open": {
		const mermaid = flag("--from-mermaid");
		const noWindow = bool("--no-window");
		// Read the mermaid source before resolveFile(create) so a typo does not leave an empty diagram behind.
		let mermaidSrc;
		if (mermaid) {
			const src = path.resolve(mermaid);
			if (!fs.existsSync(src)) die(`[excal] mermaid 파일이 없습니다: ${src}`);
			try {
				mermaidSrc = fs.readFileSync(src, "utf8");
			} catch (err) {
				die(`[excal] mermaid 파일을 읽지 못했습니다: ${src} (${err.message})`);
			}
		}
		const file = resolveFile(rest[0], { create: true });
		if (mermaidSrc !== undefined) {
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			data.pendingMermaid = mermaidSrc;
			writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
		}
		const srv = await ensureServer();
		const info = await register(srv, file);
		let windowState = "already-open";
		if (info.clients === 0) windowState = noWindow ? "not-opened" : await openWindow(srv, info);
		console.log(JSON.stringify({ file, url: info.url, window: windowState }, null, 2));
		if (mermaid)
			console.error(
				windowState === "opened" || windowState === "already-open"
					? "[excal] mermaid 변환은 창에서 수행됩니다. 변환 후 파일이 정식 포맷으로 다시 저장됩니다."
					: `[excal] 창이 없어 mermaid 변환이 보류됩니다 (window: ${windowState}). 파일에는 pendingMermaid만 남습니다.`,
			);
		break;
	}
	case "inspect":
		inspect(resolveFile(rest[0]));
		break;
	case "lint":
		lint(resolveFile(rest[0]));
		break;
	case "snapshot": {
		const out = flag("-o");
		const file = resolveFile(rest[0]);
		const srv = await ensureServer();
		const info = await register(srv, file);
		if (info.clients === 0) {
			const windowState = await openWindow(srv, info);
			if (windowState !== "opened")
				die(`[excal] 창에 연결하지 못해 스냅샷을 찍을 수 없습니다 (window: ${windowState})`);
		}
		const r = await call(srv.port, srv.token, `/api/files/${info.id}/snapshot`, { method: "POST" });
		if (!r.ok) die(`[excal] 스냅샷 실패: ${await r.text()}`);
		const target = out
			? path.resolve(out)
			: path.join(SNAPSHOT_DIR, `${path.basename(file, path.extname(file))}-${info.id}.png`);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
		console.log(target);
		break;
	}
	case "history": {
		const file = resolveFile(rest[0]);
		const dir = path.join(HISTORY_DIR, fileIdFor(file));
		const items = fs.existsSync(dir)
			? fs
					.readdirSync(dir)
					.filter((f) => f.endsWith(".excalidraw"))
					.sort()
					.reverse()
			: [];
		if (!items.length) console.log("히스토리 없음");
		for (const f of items)
			console.log(`${new Date(Number(path.basename(f, ".excalidraw"))).toLocaleString("ko-KR")}  ${path.join(dir, f)}`);
		break;
	}
	case "status": {
		const token = readToken();
		const state = readJSON(STATE_FILE, null);
		if (!(await healthy(state, token))) {
			console.log("서버 꺼짐");
			break;
		}
		console.log(JSON.stringify(await (await call(state.port, token, "/api/status")).json(), null, 2));
		break;
	}
	case "stop": {
		const token = readToken();
		const state = readJSON(STATE_FILE, null);
		if (await healthy(state, token)) await call(state.port, token, "/api/shutdown", { method: "POST" });
		console.log("stopped");
		break;
	}
	case "build":
		ensureBuilt(true);
		console.log("built");
		break;
	default:
		die(USAGE);
}
