#!/usr/bin/env node
// Local Excalidraw sync daemon.
// - serves the prebuilt app (app/dist)
// - watches registered .excalidraw files and pushes changes to open windows (WebSocket)
// - writes edits coming from the window back to disk (atomic, rev-checked)
// - relays PNG snapshot requests to a connected window
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
	DIST_DIR,
	ensureStateDir,
	fileIdFor,
	HISTORY_DIR,
	REGISTRY_FILE,
	readJSON,
	readToken,
	realPathOf,
	STATE_FILE,
	sha,
	writeFileAtomic,
} from "./lib.mjs";

const PREFERRED_PORT = Number(process.env.EXCAL_PORT || 47813);
const IDLE_MS = Number(process.env.EXCAL_IDLE_MINUTES || 30) * 60_000;
const HISTORY_KEEP = 50;
const USER_HISTORY_INTERVAL_MS = 5 * 60_000;
const MAX_BODY = 64 * 1024 * 1024;

ensureStateDir();
const TOKEN = readToken();
let PORT = 0;
let lastActivity = Date.now();

/** @type {Map<string, any>} */
const entries = new Map();
/** @type {Map<string, {watcher: fs.FSWatcher, ids: Set<string>}>} */
const dirWatchers = new Map();
/** @type {Map<string, {res: http.ServerResponse, timer: NodeJS.Timeout}>} */
const pendingSnapshots = new Map();
const registry = readJSON(REGISTRY_FILE, {});

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

function saveRegistry() {
	fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

// ---------- file entries ----------

function getEntry(id) {
	if (entries.has(id)) return entries.get(id);
	const filePath = registry[id];
	if (!filePath) return null;
	return activate(id, filePath);
}

function activate(id, filePath) {
	let content = "";
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {}
	const entry = {
		id,
		path: filePath,
		rev: 1,
		lastContent: content,
		lastHash: sha(content),
		lastUserHistoryAt: 0,
		clients: new Map(),
		timer: null,
	};
	entries.set(id, entry);
	watchDir(entry);
	return entry;
}

function watchDir(entry) {
	const dir = path.dirname(entry.path);
	let w = dirWatchers.get(dir);
	if (!w) {
		// Watch the directory, not the file: editors save via temp file + rename,
		// which silently detaches a file-level watcher.
		const watcher = fs.watch(dir, (_event, filename) => {
			const ids = dirWatchers.get(dir)?.ids ?? new Set();
			for (const id of ids) {
				const e = entries.get(id);
				if (!e) continue;
				if (filename && filename.toString() !== path.basename(e.path)) continue;
				scheduleCheck(e);
			}
		});
		watcher.on("error", (err) => log("watch error", dir, err.message));
		w = { watcher, ids: new Set() };
		dirWatchers.set(dir, w);
	}
	w.ids.add(entry.id);
}

function scheduleCheck(entry) {
	clearTimeout(entry.timer);
	entry.timer = setTimeout(() => checkFile(entry), 80);
}

/** Pick up an external change on disk. Returns true when a new revision was accepted. */
function checkFile(entry, attempt = 0) {
	let content;
	try {
		content = fs.readFileSync(entry.path, "utf8");
	} catch (err) {
		if (err.code === "ENOENT" && attempt < 3) {
			entry.timer = setTimeout(() => checkFile(entry, attempt + 1), 150);
		} else if (err.code === "ENOENT") {
			broadcast(entry, "problem", { message: `파일이 없습니다: ${entry.path}` });
		}
		return false;
	}
	const hash = sha(content);
	if (hash === entry.lastHash) return false;
	try {
		JSON.parse(content);
	} catch (err) {
		broadcast(entry, "problem", { message: `JSON 파싱 실패: ${err.message}` });
		return false;
	}
	saveHistory(entry, entry.lastContent);
	entry.lastContent = content;
	entry.lastHash = hash;
	entry.rev += 1;
	log("disk change", entry.path, "rev", entry.rev);
	broadcast(entry, "scene", { rev: entry.rev, content, origin: "disk" });
	return true;
}

function saveHistory(entry, content) {
	if (!content) return;
	const dir = path.join(HISTORY_DIR, entry.id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${Date.now()}.excalidraw`), content);
	const files = fs.readdirSync(dir).sort();
	for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) {
		fs.rmSync(path.join(dir, f), { force: true });
	}
	fs.writeFileSync(path.join(dir, "SOURCE"), entry.path + "\n");
}

// ---------- minimal WebSocket (server -> client text frames only) ----------

function wsFrame(opcode, payload = Buffer.alloc(0)) {
	const len = payload.length;
	let header;
	if (len < 126) header = Buffer.from([0x80 | opcode, len]);
	else if (len < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 126;
		header.writeUInt16BE(len, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(len), 2);
	}
	return Buffer.concat([header, payload]);
}

function wsSend(socket, event, data) {
	if (!socket.destroyed) socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ event, data }))));
}

function broadcast(entry, event, data, exceptClientId) {
	for (const [clientId, socket] of entry.clients) {
		if (clientId === exceptClientId) continue;
		wsSend(socket, event, data);
	}
}

function totalClients() {
	let n = 0;
	for (const e of entries.values()) n += e.clients.size;
	return n;
}

// ---------- http helpers ----------

function send(res, status, body, headers = {}) {
	const isBuf = Buffer.isBuffer(body);
	const data = isBuf ? body : typeof body === "string" ? body : JSON.stringify(body);
	res.writeHead(status, {
		"content-type": isBuf
			? "application/octet-stream"
			: typeof body === "string"
				? "text/plain; charset=utf-8"
				: "application/json",
		"cache-control": "no-store",
		...headers,
	});
	res.end(data);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
};

function serveStatic(req, res, pathname) {
	const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
	let file = path.join(DIST_DIR, rel);
	if (!file.startsWith(DIST_DIR)) return send(res, 403, "forbidden");
	if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST_DIR, "index.html");
	if (!fs.existsSync(file)) return send(res, 503, "app is not built. run: excal build");
	const ext = path.extname(file);
	const immutable = rel.startsWith("assets/") || rel.startsWith("fonts/");
	res.writeHead(200, {
		"content-type": MIME[ext] || "application/octet-stream",
		"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
	});
	fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------

async function handleApi(req, res, url) {
	const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
	const method = req.method;

	if (parts[1] === "health") return send(res, 200, { ok: true, pid: process.pid, port: PORT });

	if (parts[1] === "status") {
		return send(res, 200, {
			pid: process.pid,
			port: PORT,
			files: [...entries.values()].map((e) => ({ id: e.id, path: e.path, rev: e.rev, clients: e.clients.size })),
		});
	}

	if (parts[1] === "shutdown" && method === "POST") {
		send(res, 200, { ok: true });
		setTimeout(shutdown, 50);
		return;
	}

	if (parts[1] === "files" && parts.length === 2 && method === "POST") {
		const { path: p } = JSON.parse((await readBody(req)).toString() || "{}");
		if (!p) return send(res, 400, { error: "path required" });
		const abs = realPathOf(p);
		if (!fs.existsSync(abs)) return send(res, 404, { error: `file not found: ${abs}` });
		const id = fileIdFor(abs);
		if (registry[id] !== abs) {
			registry[id] = abs;
			saveRegistry();
		}
		const entry = getEntry(id);
		checkFile(entry);
		return send(res, 200, {
			id,
			path: abs,
			rev: entry.rev,
			clients: entry.clients.size,
			url: `http://127.0.0.1:${PORT}/?file=${id}&token=${TOKEN}`,
		});
	}

	if (parts[1] === "snapshots" && parts[2] && method === "POST") {
		const pending = pendingSnapshots.get(parts[2]);
		const body = await readBody(req);
		if (!pending) return send(res, 404, { error: "unknown snapshot request" });
		pendingSnapshots.delete(parts[2]);
		clearTimeout(pending.timer);
		if (req.headers["content-type"]?.startsWith("application/json")) {
			send(pending.res, 500, JSON.parse(body.toString()));
		} else {
			send(pending.res, 200, body, { "content-type": "image/png" });
		}
		return send(res, 204, "");
	}

	if (parts[1] === "files" && parts[2]) {
		const entry = getEntry(parts[2]);
		if (!entry) return send(res, 404, { error: "unknown file id" });
		const action = parts[3];

		if (action === "scene" && method === "GET") {
			checkFile(entry);
			return send(res, 200, {
				rev: entry.rev,
				content: entry.lastContent,
				path: entry.path,
				name: path.basename(entry.path),
			});
		}

		if (action === "scene" && method === "PUT") {
			const { baseRev, content, clientId } = JSON.parse((await readBody(req)).toString());
			checkFile(entry); // flush a disk change the watcher may not have delivered yet
			if (baseRev !== entry.rev) return send(res, 409, { rev: entry.rev, content: entry.lastContent });
			try {
				JSON.parse(content);
			} catch {
				return send(res, 400, { error: "invalid JSON" });
			}
			const hash = sha(content);
			if (hash !== entry.lastHash) {
				if (Date.now() - entry.lastUserHistoryAt > USER_HISTORY_INTERVAL_MS) {
					saveHistory(entry, entry.lastContent);
					entry.lastUserHistoryAt = Date.now();
				}
				writeFileAtomic(entry.path, content);
				entry.lastContent = content;
				entry.lastHash = hash;
				entry.rev += 1;
				broadcast(entry, "scene", { rev: entry.rev, content, origin: clientId }, clientId);
			}
			return send(res, 200, { rev: entry.rev });
		}

		if (action === "snapshot" && method === "POST") {
			checkFile(entry);
			const [clientId, client] = [...entry.clients.entries()][0] ?? [];
			if (!client) return send(res, 409, { error: "no-window" });
			const reqId = crypto.randomUUID();
			const timer = setTimeout(() => {
				pendingSnapshots.delete(reqId);
				send(res, 504, { error: "snapshot timeout" });
			}, 20_000);
			pendingSnapshots.set(reqId, { res, timer });
			wsSend(client, "snapshot", { reqId, rev: entry.rev });
			log("snapshot requested", entry.path, "client", clientId);
			return;
		}
	}

	return send(res, 404, { error: "not found" });
}

const hostOk = (host = "") => host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;

const server = http.createServer(async (req, res) => {
	lastActivity = Date.now();
	const host = req.headers.host || "";
	if (!hostOk(host)) return send(res, 403, "bad host");
	const url = new URL(req.url, `http://${host}`);
	try {
		if (url.pathname.startsWith("/api/")) {
			const token = req.headers["x-excal-token"] || url.searchParams.get("token");
			if (token !== TOKEN) return send(res, 401, { error: "bad token" });
			return await handleApi(req, res, url);
		}
		return serveStatic(req, res, url.pathname);
	} catch (err) {
		log("error", err.stack || err.message);
		if (!res.headersSent) send(res, 500, { error: err.message });
	}
});

server.on("upgrade", (req, socket) => {
	lastActivity = Date.now();
	const reject = (code) => socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
	if (!hostOk(req.headers.host)) return reject("403 Forbidden");
	const url = new URL(req.url, `http://${req.headers.host}`);
	const m = url.pathname.match(/^\/api\/files\/([a-f0-9]+)\/ws$/);
	if (!m || url.searchParams.get("token") !== TOKEN) return reject("401 Unauthorized");
	const entry = getEntry(m[1]);
	const key = req.headers["sec-websocket-key"];
	if (!entry || !key) return reject("404 Not Found");
	const accept = crypto
		.createHash("sha1")
		.update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
		.digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	socket.setNoDelay(true);
	const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
	entry.clients.set(clientId, socket);
	checkFile(entry);
	wsSend(socket, "hello", { rev: entry.rev });
	const ping = setInterval(() => !socket.destroyed && socket.write(wsFrame(0x9)), 20_000);
	// The browser never sends data frames; only watch for a close frame.
	socket.on("data", (buf) => {
		if ((buf[0] & 0x0f) === 0x8) socket.end(wsFrame(0x8));
	});
	const cleanup = () => {
		clearInterval(ping);
		if (entry.clients.get(clientId) === socket) entry.clients.delete(clientId);
		lastActivity = Date.now();
	};
	socket.on("close", cleanup);
	socket.on("error", cleanup);
});

function shutdown() {
	log("shutdown");
	const state = readJSON(STATE_FILE, null);
	if (state?.pid === process.pid) fs.rmSync(STATE_FILE, { force: true });
	for (const e of entries.values()) for (const socket of e.clients.values()) socket.end(wsFrame(0x8));
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

setInterval(() => {
	if (totalClients() === 0 && Date.now() - lastActivity > IDLE_MS) {
		log("idle timeout");
		shutdown();
	}
}, 60_000).unref();

function listen(port) {
	server.once("error", (err) => {
		if (err.code === "EADDRINUSE" && port !== 0) return listen(0);
		throw err;
	});
	server.listen(port, "127.0.0.1", () => {
		PORT = server.address().port;
		fs.writeFileSync(
			STATE_FILE,
			JSON.stringify({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() }),
			{
				mode: 0o600,
			},
		);
		log(`listening on http://127.0.0.1:${PORT}`);
	});
}

// Single instance: bail out if a healthy daemon already owns the state file.
const existing = readJSON(STATE_FILE, null);
if (existing?.pid && existing.pid !== process.pid) {
	let alive = false;
	try {
		process.kill(existing.pid, 0);
		alive = true;
	} catch {}
	if (alive) {
		try {
			const r = await fetch(`http://127.0.0.1:${existing.port}/api/health`, {
				headers: { "x-excal-token": TOKEN },
				signal: AbortSignal.timeout(1000),
			});
			if (r.ok) {
				log("another daemon is running", existing);
				process.exit(0);
			}
		} catch {}
	}
}
listen(PREFERRED_PORT);
