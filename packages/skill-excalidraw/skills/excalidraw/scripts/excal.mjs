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
		const r = spawnSync(pm, ["install"], { cwd: APP_DIR, stdio: ["ignore", 2, 2] });
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
	if (process.platform === "darwin") return ["open", ["-na", "Google Chrome", "--args", ...args]];
	for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
		if (spawnSync("which", [bin]).status === 0) return [bin, args];
	}
	return null;
}

async function openWindow(srv, info) {
	if (process.env.EXCAL_BROWSER === "none") return false;
	const cmd = chromeCommand(info.url);
	if (!cmd) {
		console.error(`[excal] Chrome을 찾지 못했습니다. 직접 여세요: ${info.url}`);
		return false;
	}
	spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" }).unref();
	return waitForClient(srv, info.id, 20_000);
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
	const boxes = visible.filter((e) => typeof e.x === "number" && typeof e.width === "number");
	const minX = Math.min(...boxes.map((e) => e.x));
	const minY = Math.min(...boxes.map((e) => e.y));
	const maxX = Math.max(...boxes.map((e) => e.x + Math.abs(e.width)));
	const maxY = Math.max(...boxes.map((e) => e.y + Math.abs(e.height ?? 0)));
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
			.filter((e) => (SHAPES.has(e.type) || (e.type === "text" && !e.containerId)) && typeof e.x === "number")
			.map((e) => {
				const w =
					typeof e.width === "number"
						? e.width
						: e.type === "text"
							? textWidthEstimate(e.text, e.fontSize ?? 20)
							: undefined;
				const h =
					typeof e.height === "number"
						? e.height
						: e.type === "text"
							? (e.fontSize ?? 20) * 1.25 * String(e.text).split("\n").length
							: undefined;
				return w === undefined || h === undefined
					? null
					: { id: e.id ?? e.type, x1: e.x, y1: e.y, x2: e.x + w, y2: e.y + h };
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
		const file = resolveFile(rest[0], { create: true });
		if (mermaid) {
			const src = fs.readFileSync(path.resolve(mermaid), "utf8");
			const data = JSON.parse(fs.readFileSync(file, "utf8"));
			data.pendingMermaid = src;
			writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
		}
		const srv = await ensureServer();
		const info = await register(srv, file);
		let windowState = "already-open";
		if (info.clients === 0) {
			windowState = noWindow ? "not-opened" : (await openWindow(srv, info)) ? "opened" : "not-connected";
		}
		console.log(JSON.stringify({ file, url: info.url, window: windowState }, null, 2));
		if (mermaid && windowState !== "not-opened")
			console.error("[excal] mermaid 변환은 창에서 수행됩니다. 변환 후 파일이 정식 포맷으로 다시 저장됩니다.");
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
		if (info.clients === 0 && !(await openWindow(srv, info)))
			die("[excal] 창에 연결하지 못해 스냅샷을 찍을 수 없습니다");
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
