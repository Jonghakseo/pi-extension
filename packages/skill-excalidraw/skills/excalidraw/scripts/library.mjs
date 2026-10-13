// Excalidraw library support shared by the CLI and the sync server.
// One personal library file (STATE_DIR/library.excalidrawlib) backs both the
// window's library panel and `excal library` commands.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJSON, STATE_DIR, writeFileAtomic } from "./lib.mjs";

export const LIBRARY_FILE = path.join(STATE_DIR, "library.excalidrawlib");
export const CATALOG_CACHE = path.join(STATE_DIR, "library-catalog.json");
export const CATALOG_URL =
	process.env.EXCAL_LIBRARY_CATALOG ||
	"https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries.json";
export const LIBRARIES_BASE = "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries/";
const CATALOG_TTL_MS = 24 * 60 * 60_000;

/** Same allowlist Excalidraw's useHandleLibrary uses by default. */
const ALLOWED = ["excalidraw.com", "raw.githubusercontent.com/excalidraw/excalidraw-libraries"];

export function isAllowedLibraryUrl(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== "https:") return false;
	return ALLOWED.some((entry) => {
		const { hostname, pathname } = new URL(`https://${entry}`);
		const hostOk = u.hostname === hostname || u.hostname.endsWith(`.${hostname}`);
		const prefix = pathname.replace(/\/+$/, "");
		return hostOk && (prefix === "" || u.pathname === prefix || u.pathname.startsWith(`${prefix}/`));
	});
}

// ---------- library file ----------

/** Turn any .excalidrawlib payload (v1 `library`, v2 `libraryItems`) into v2 items. */
export function normalizeItems(data, { name } = {}) {
	const raw = Array.isArray(data?.libraryItems)
		? data.libraryItems
		: Array.isArray(data?.library)
			? data.library
			: null;
	if (!raw) throw new Error("excalidrawlib 형식이 아닙니다 (library / libraryItems 배열 없음)");
	const items = [];
	raw.forEach((entry, i) => {
		const elements = (Array.isArray(entry) ? entry : entry?.elements || []).filter((e) => e && !e.isDeleted);
		if (!elements.length) return;
		const item = {
			id: (!Array.isArray(entry) && entry.id) || randomId(),
			status: (!Array.isArray(entry) && entry.status) || "published",
			elements,
			created: (!Array.isArray(entry) && entry.created) || Date.now(),
		};
		const itemName = !Array.isArray(entry) && entry.name;
		if (itemName) item.name = itemName;
		else if (name) item.name = raw.length > 1 ? `${name} #${i + 1}` : name;
		items.push(item);
	});
	return items;
}

/**
 * Missing file means an empty library. A file that exists but does not parse
 * throws: returning [] would let the next save replace the user's library.
 */
export function readLibrary(file = LIBRARY_FILE) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return [];
		throw err;
	}
	try {
		return normalizeItems(JSON.parse(text));
	} catch (err) {
		throw new Error(
			`라이브러리 파일이 손상됐습니다: ${file} (${err.message}). 고치거나 ${path.basename(file)}.bak으로 되돌리세요`,
		);
	}
}

export function serializeLibrary(items) {
	return `${JSON.stringify({ type: "excalidrawlib", version: 2, source: "pi-excalidraw", libraryItems: items }, null, 2)}\n`;
}

/** Writes atomically and keeps the previous version as `<file>.bak`. */
export function writeLibrary(items, file = LIBRARY_FILE) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
	writeFileAtomic(file, serializeLibrary(items));
}

/** Shape signature that ignores ids and position, to skip re-adding the same item. */
function itemSignature(item) {
	const box = boundsOf(item.elements);
	return JSON.stringify(
		item.elements.map((e) => [
			e.type,
			Math.round(e.x - box.x),
			Math.round(e.y - box.y),
			Math.round(e.width ?? 0),
			Math.round(e.height ?? 0),
			e.text ?? "",
		]),
	);
}

/** Append items, skipping ones whose id or shape is already in the library. */
export function mergeItems(existing, incoming) {
	const ids = new Set(existing.map((i) => i.id));
	const sigs = new Set(existing.map(itemSignature));
	const added = [];
	for (const item of incoming) {
		const sig = itemSignature(item);
		if (ids.has(item.id) || sigs.has(sig)) continue;
		ids.add(item.id);
		sigs.add(sig);
		added.push(item);
	}
	// Excalidraw lists the newest items first.
	return { items: [...added, ...existing], added: added.length, skipped: incoming.length - added.length };
}

// ---------- catalog ----------

async function fetchText(url) {
	const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
	if (!r.ok) throw new Error(`${url} 응답 ${r.status}`);
	return r.text();
}

export async function loadCatalog({ refresh = false } = {}) {
	if (!/^https?:/.test(CATALOG_URL)) return JSON.parse(fs.readFileSync(CATALOG_URL, "utf8"));
	const cached = readJSON(CATALOG_CACHE, null);
	if (!refresh && cached?.url === CATALOG_URL && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.items;
	try {
		const items = JSON.parse(await fetchText(CATALOG_URL));
		fs.mkdirSync(path.dirname(CATALOG_CACHE), { recursive: true });
		fs.writeFileSync(CATALOG_CACHE, JSON.stringify({ url: CATALOG_URL, fetchedAt: Date.now(), items }));
		return items;
	} catch (err) {
		if (cached?.items) return cached.items; // offline: stale cache beats nothing
		throw new Error(`라이브러리 목록을 받지 못했습니다: ${err.message}`);
	}
}

export function searchCatalog(catalog, query) {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hay = (l) => [l.name, l.description, l.source, ...(l.authors || []).map((a) => a.name)].join(" ").toLowerCase();
	return catalog
		.filter((l) => terms.every((t) => hay(l).includes(t)))
		.map((l) => ({ l, score: terms.filter((t) => l.name.toLowerCase().includes(t)).length }))
		.sort((a, b) => b.score - a.score || String(b.l.updated).localeCompare(String(a.l.updated)))
		.map(({ l }) => l);
}

/** Resolve a catalog id, source path or name to a catalog entry. */
export function findCatalogEntry(catalog, ref) {
	const r = ref.toLowerCase().replace(/\.excalidrawlib$/, "");
	return (
		catalog.find((l) => l.id === ref) ||
		catalog.find((l) => l.source.toLowerCase().replace(/\.excalidrawlib$/, "") === r) ||
		catalog.find((l) => l.name.toLowerCase() === r)
	);
}

/**
 * Load library items from a local .excalidrawlib path, an allowed URL, or a
 * catalog reference (id, `author/name` source, or exact name).
 */
export async function fetchLibrary(ref, { refresh = false } = {}) {
	if (fs.existsSync(ref) && fs.statSync(ref).isFile()) {
		const name = path.basename(ref, path.extname(ref));
		return { name, from: path.resolve(ref), items: normalizeItems(JSON.parse(fs.readFileSync(ref, "utf8")), { name }) };
	}
	let url = ref;
	let name;
	if (!/^https?:\/\//.test(ref)) {
		const entry = findCatalogEntry(await loadCatalog({ refresh }), ref);
		if (!entry)
			throw new Error(`카탈로그에서 "${ref}"를 찾지 못했습니다. \`excal library search <키워드>\`로 id를 확인하세요`);
		url = LIBRARIES_BASE + entry.source;
		name = entry.name;
	}
	if (!isAllowedLibraryUrl(url))
		throw new Error(`허용되지 않은 라이브러리 URL입니다: ${url} (excalidraw.com, excalidraw-libraries 저장소만 허용)`);
	name ??= decodeURIComponent(new URL(url).pathname.split("/").pop() || "library").replace(/\.excalidrawlib$/, "");
	return { name, from: url, items: normalizeItems(JSON.parse(await fetchText(url)), { name }) };
}

// ---------- items ----------

export function randomId() {
	return crypto.randomBytes(8).toString("base64url");
}

/** Bounding box of elements, including line/arrow points. */
export function boundsOf(elements) {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const e of elements) {
		if (Array.isArray(e.points) && e.points.length) {
			for (const [px, py] of e.points) {
				minX = Math.min(minX, e.x + px);
				minY = Math.min(minY, e.y + py);
				maxX = Math.max(maxX, e.x + px);
				maxY = Math.max(maxY, e.y + py);
			}
		} else {
			const x2 = e.x + (e.width ?? 0);
			const y2 = e.y + (e.height ?? 0);
			minX = Math.min(minX, e.x, x2);
			minY = Math.min(minY, e.y, y2);
			maxX = Math.max(maxX, e.x, x2);
			maxY = Math.max(maxY, e.y, y2);
		}
	}
	if (minX === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function itemTexts(item) {
	return item.elements.filter((e) => e.type === "text" && e.text).map((e) => e.text.replace(/\s+/g, " "));
}

/** Find one item by exact id, exact name, or a unique name/text substring. */
export function findItem(items, ref) {
	const r = ref.toLowerCase();
	const exact = items.filter((i) => i.id === ref || (i.name || "").toLowerCase() === r);
	if (exact.length === 1) return exact[0];
	const partial = (exact.length ? exact : items).filter((i) =>
		[i.name || "", ...itemTexts(i)].some((s) => s.toLowerCase().includes(r)),
	);
	if (partial.length === 1) return partial[0];
	if (!partial.length) throw new Error(`라이브러리에 "${ref}" 아이템이 없습니다. \`excal library list\`로 확인하세요`);
	throw new Error(
		`"${ref}"에 맞는 아이템이 ${partial.length}개입니다. id로 지정하세요:\n${partial
			.slice(0, 10)
			.map((i) => `  ${i.id}  ${i.name ?? ""}`)
			.join("\n")}`,
	);
}

/**
 * Copy an item's elements for placement in a scene: fresh ids (prefix-1, prefix-2, ...),
 * remapped internal references, an outer group `prefix` so the item moves as one,
 * top-left moved to (x, y), optionally scaled to `width`.
 */
export function instantiateItem(item, { prefix, x = 0, y = 0, width, takenIds = new Set() }) {
	const src = item.elements.filter((e) => !e.isDeleted);
	const box = boundsOf(src);
	const scale = width && box.width > 0 ? width / box.width : 1;
	const idMap = new Map(src.map((e, i) => [e.id, `${prefix}-${i + 1}`]));
	const groupMap = new Map();
	for (const e of src)
		for (const g of e.groupIds || []) if (!groupMap.has(g)) groupMap.set(g, `${prefix}-g${groupMap.size + 1}`);
	for (const id of [prefix, ...idMap.values(), ...groupMap.values()])
		if (takenIds.has(id)) throw new Error(`id "${id}"가 이미 파일에 있습니다. --id로 다른 접두사를 주세요`);
	const outer = src.length > 1 ? [prefix] : [];
	const mapId = (id) => (id && idMap.has(id) ? idMap.get(id) : null);
	const now = Date.now();
	const elements = src.map((e) => {
		const next = {
			...e,
			id: idMap.get(e.id),
			x: x + (e.x - box.x) * scale,
			y: y + (e.y - box.y) * scale,
			groupIds: [...(e.groupIds || []).map((g) => groupMap.get(g)), ...outer],
			frameId: mapId(e.frameId),
			version: 1,
			versionNonce: Math.floor(Math.random() * 2 ** 31),
			seed: Math.floor(Math.random() * 2 ** 31),
			updated: now,
			isDeleted: false,
		};
		if (typeof e.width === "number") next.width = e.width * scale;
		if (typeof e.height === "number") next.height = e.height * scale;
		if (Array.isArray(e.points)) next.points = e.points.map(([px, py]) => [px * scale, py * scale]);
		if (typeof e.fontSize === "number") next.fontSize = e.fontSize * scale;
		if ("containerId" in e) next.containerId = mapId(e.containerId);
		if (Array.isArray(e.boundElements))
			next.boundElements = e.boundElements.filter((b) => idMap.has(b.id)).map((b) => ({ ...b, id: idMap.get(b.id) }));
		if (Array.isArray(e.boundElementIds)) {
			// legacy v1 field; restoreElements converts it, keep it consistent
			next.boundElementIds = e.boundElementIds.filter((id) => idMap.has(id)).map((id) => idMap.get(id));
		}
		for (const key of ["startBinding", "endBinding"])
			if (e[key])
				next[key] = idMap.has(e[key].elementId) ? { ...e[key], elementId: idMap.get(e[key].elementId) } : null;
		return next;
	});
	return {
		elements,
		group: outer[0] ?? null,
		box: { x, y, width: box.width * scale, height: box.height * scale },
		hasImages: src.some((e) => e.type === "image"),
	};
}
