import {
	CaptureUpdateAction,
	convertToExcalidrawElements,
	Excalidraw,
	exportToBlob,
	FONT_FAMILY,
	restoreElements,
	serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	contentKey,
	convertMixed,
	isSkeleton,
	recenterLabels,
	repairScene,
	sameContent,
	sceneSig,
	threeWayMerge,
} from "./scene.js";

const params = new URLSearchParams(location.search);
const FILE_ID = params.get("file");
const TOKEN = params.get("token");
const CLIENT_ID = crypto.randomUUID();
const SAVE_DEBOUNCE_MS = 400;
const RESTORE_OPTS = { refreshDimensions: true, repairBindings: true };
const randomNonce = () => Math.floor(Math.random() * 2 ** 31);
const FONT_NAME = Object.fromEntries(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]));

/** Same font stack Excalidraw measures and renders text with. */
function fontString(fontSize = 20, fontFamily = FONT_FAMILY.Excalifont) {
	const name = FONT_NAME[fontFamily] ?? "Excalifont";
	const cjk = fontFamily === FONT_FAMILY.Excalifont ? ", Xiaolai" : "";
	return `${fontSize}px ${name}${cjk}, Segoe UI Emoji`;
}

/**
 * Load the glyphs the scene's text needs before measuring it. Excalidraw
 * measures with whatever font is ready, and CJK glyphs (Xiaolai) load lazily per
 * unicode-range chunk; a width measured with a fallback font stays in the
 * element after the real font arrives, and the renderer clips text to it.
 */
async function loadTextFonts(elements) {
	const chars = new Map();
	for (const e of elements) {
		if (e.isDeleted) continue;
		const src = e.type === "text" ? e : e.label;
		if (typeof src?.text !== "string" || !src.text) continue;
		const font = fontString(src.fontSize, src.fontFamily);
		chars.set(font, (chars.get(font) ?? "") + src.text);
	}
	await Promise.all([...chars].map(([font, text]) => document.fonts.load(font, text).catch(() => [])));
	await document.fonts.ready;
}

async function api(pathname, init = {}) {
	return fetch(`/api/files/${FILE_ID}${pathname}`, {
		...init,
		headers: { "x-excal-token": TOKEN, ...(init.headers || {}) },
	});
}

/** Parse file content and turn skeleton / mermaid input into full elements. */
async function prepareScene(content, prevElements = []) {
	const data = JSON.parse(content);
	let elements = Array.isArray(data.elements) ? data.elements : [];
	let normalized = false;
	if (typeof data.pendingMermaid === "string" && data.pendingMermaid.trim()) {
		// A mermaid import replaces the diagram. Node ids are stable, so
		// re-importing an edited .mmd updates the same elements in place.
		const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
		const { elements: skel } = await parseMermaidToExcalidraw(data.pendingMermaid, {
			themeVariables: { fontSize: "20px" },
		});
		elements = convertToExcalidrawElements(skel, { regenerateIds: false });
		normalized = true;
	}
	if (elements.some(isSkeleton)) {
		elements = convertMixed(elements);
		normalized = true;
	}
	const repaired = repairScene(elements, prevElements);
	if (repaired.changed) {
		elements = repaired.elements;
		normalized = true;
	}
	return { elements, appState: data.appState || {}, files: data.files || {}, normalized };
}

function describe(ids, elements) {
	const byId = new Map(elements.map((e) => [e.id, e]));
	const labelOf = (id) => {
		const el = byId.get(id);
		if (!el) return null;
		if (el.type === "text") return el.text;
		const t = (el.boundElements || []).find((b) => b.type === "text");
		return t ? byId.get(t.id)?.text : null;
	};
	const named = ids.map(labelOf).filter(Boolean);
	if (!named.length) return `요소 ${ids.length}개`;
	const head = `"${named[0].split("\n")[0].slice(0, 20)}"`;
	return ids.length > 1 ? `${head} 외 ${ids.length - 1}개` : head;
}

function App() {
	const [excalidrawAPI, setAPI] = useState(null);
	const [status, setStatus] = useState("연결 중");
	const s = useRef({
		rev: 0,
		ready: false,
		lastSig: "",
		lastError: null,
		baseline: new Map(),
		saveTimer: null,
		queue: Promise.resolve(),
		firstLoad: true,
	}).current;

	// Serialize all scene mutations (remote apply / save) so they never interleave.
	const enqueue = useCallback((fn) => {
		s.queue = s.queue.then(fn).catch((err) => {
			console.error(err);
			s.lastError = err.message;
			setStatus(`오류: ${err.message}`);
		});
		return s.queue;
	}, []);

	const setBaseline = (elements) => {
		s.baseline = new Map(elements.map((e) => [e.id, { version: e.version, key: contentKey(e) }]));
	};

	const save = useCallback(async () => {
		const API = excalidrawAPI;
		const elements = API.getSceneElementsIncludingDeleted();
		const content = serializeAsJSON(elements, API.getAppState(), API.getFiles(), "local");
		setStatus("저장 중");
		const res = await api("/scene", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ baseRev: s.rev, content, clientId: CLIENT_ID }),
		});
		if (res.status === 409) {
			const { rev, content: remote } = await res.json();
			await applyRemote(remote, rev);
			return;
		}
		if (!res.ok) throw new Error(`save failed ${res.status}`);
		s.rev = (await res.json()).rev;
		s.lastSig = sceneSig(elements);
		setBaseline(elements.filter((e) => !e.isDeleted));
		setStatus("동기화됨");
	}, [excalidrawAPI]);

	const applyRemote = useCallback(
		async (content, rev) => {
			const API = excalidrawAPI;
			const local = API.getSceneElementsIncludingDeleted();
			const prepared = await prepareScene(content, local);
			await loadTextFonts(prepared.elements);
			// Label centering needs the text size re-measured by restoreElements.
			const { elements: remote } = recenterLabels(restoreElements(prepared.elements, local, RESTORE_OPTS));
			// Anything restore/recenter fixed (dangling bindings, text size, label
			// position) must reach the file too, not just the canvas.
			const writeBack = prepared.normalized || !sameContent(prepared.elements, remote);

			const dirty = sceneSig(local) !== s.lastSig && !s.firstLoad;
			let { elements, keptLocal } = dirty
				? threeWayMerge(s.baseline, remote, local)
				: { elements: remote, keptLocal: 0 };

			// Elements removed in the file become tombstones and changed ones get a
			// version bump; otherwise Excalidraw's store sees no change and Cmd+Z
			// would skip (and later clobber) the external edit.
			const localById = new Map(local.map((e) => [e.id, e]));
			const ids = new Set(elements.map((e) => e.id));
			elements = [
				...elements,
				...local.filter((l) => !l.isDeleted && !ids.has(l.id)).map((l) => ({ ...l, isDeleted: true })),
			];
			elements = elements.map((e) => {
				const l = localById.get(e.id);
				if (!l || contentKey(l) === contentKey(e)) return e;
				return { ...e, version: Math.max(l.version, e.version) + 1, versionNonce: randomNonce() };
			});

			const changedIds = new Set();
			for (const e of elements) {
				const l = localById.get(e.id);
				if (l && contentKey(l) === contentKey(e)) continue;
				if (!l && e.isDeleted) continue;
				changedIds.add(e.type === "text" && e.containerId ? e.containerId : e.id);
			}

			API.updateScene({
				elements,
				appState: prepared.appState.viewBackgroundColor
					? { viewBackgroundColor: prepared.appState.viewBackgroundColor }
					: {},
				captureUpdate: s.firstLoad ? CaptureUpdateAction.NEVER : CaptureUpdateAction.IMMEDIATELY,
			});
			if (Object.keys(prepared.files).length) API.addFiles(Object.values(prepared.files));
			if (s.firstLoad) {
				API.scrollToContent(undefined, { fitToContent: true });
				s.firstLoad = false;
			} else if (changedIds.size) {
				API.setToast({
					message: `파일 변경 반영: ${describe([...changedIds], elements)} (Cmd+Z로 취소)`,
					duration: 2500,
				});
			}

			s.rev = rev;
			s.lastError = null;
			const now = API.getSceneElementsIncludingDeleted();
			s.lastSig = sceneSig(now);
			const nowById = new Map(now.map((e) => [e.id, e]));
			s.baseline = new Map(
				remote.map((r) => [r.id, { version: nowById.get(r.id)?.version ?? r.version, key: contentKey(r) }]),
			);
			s.ready = true;
			setStatus("동기화됨");
			if (writeBack || keptLocal > 0) await save();
		},
		[excalidrawAPI, save],
	);

	/**
	 * Re-measure text with the fonts that are loaded now and save if any size
	 * changed. Covers glyphs that finished loading after the last measurement
	 * (Excalidraw only repaints on font load; it keeps the stale width).
	 */
	const refitText = useCallback(async () => {
		const API = excalidrawAPI;
		if (!s.ready || API.getAppState().editingTextElement) return false;
		const current = API.getSceneElementsIncludingDeleted();
		await loadTextFonts(current);
		const live = current.filter((e) => !e.isDeleted);
		const restored = new Map(restoreElements(live, null, RESTORE_OPTS).map((e) => [e.id, e]));
		const merged = current.map((e) => (e.type === "text" && restored.has(e.id) ? restored.get(e.id) : e));
		const { elements: fitted } = recenterLabels(merged);
		let changed = 0;
		const next = fitted.map((e, i) => {
			const prev = current[i];
			if (e.type !== "text" || contentKey(prev) === contentKey(e)) return prev;
			changed++;
			return { ...e, version: prev.version + 1, versionNonce: randomNonce() };
		});
		if (!changed) return false;
		API.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
		await save();
		return true;
	}, [excalidrawAPI, save]);

	const snapshot = useCallback(
		async ({ reqId, rev }) => {
			const API = excalidrawAPI;
			const post = (body, type) =>
				fetch(`/api/snapshots/${reqId}`, {
					method: "POST",
					headers: { "x-excal-token": TOKEN, "content-type": type },
					body,
				});
			const deadline = Date.now() + 5000;
			while (s.rev < rev && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
			await s.queue;
			if (s.rev < rev) {
				const why = s.lastError ? `: ${s.lastError}` : "";
				await post(
					JSON.stringify({ error: `창이 최신 파일(rev ${rev})을 반영하지 못했습니다 (현재 rev ${s.rev})${why}` }),
					"application/json",
				);
				return;
			}
			// Fix stale text sizes first so the PNG matches what the window shows.
			await enqueue(refitText);
			try {
				const blob = await exportToBlob({
					elements: API.getSceneElements(),
					appState: { ...API.getAppState(), exportBackground: true, exportWithDarkMode: false },
					files: API.getFiles(),
					mimeType: "image/png",
					exportPadding: 24,
					getDimensions: (w, h) => {
						const scale = Math.min(2, 4000 / Math.max(w, h, 1));
						return { width: w * scale, height: h * scale, scale };
					},
				});
				await post(blob, "image/png");
			} catch (err) {
				await post(JSON.stringify({ error: err.message }), "application/json");
			}
		},
		[excalidrawAPI, refitText],
	);

	useEffect(() => {
		if (!excalidrawAPI) return;
		let timer;
		const onFontsLoaded = () => {
			clearTimeout(timer);
			timer = setTimeout(() => enqueue(refitText), 150);
		};
		document.fonts.addEventListener("loadingdone", onFontsLoaded);
		return () => {
			clearTimeout(timer);
			document.fonts.removeEventListener("loadingdone", onFontsLoaded);
		};
	}, [excalidrawAPI, refitText]);

	useEffect(() => {
		if (!excalidrawAPI) return;
		window.__excal = { api: excalidrawAPI, state: s };
		const loadLatest = () =>
			enqueue(async () => {
				const res = await api("/scene");
				if (!res.ok) throw new Error(`load failed ${res.status}`);
				const { rev, content, name } = await res.json();
				document.title = `${name} · Excalidraw`;
				if (rev !== s.rev) await applyRemote(content, rev);
			});
		const handlers = {
			hello: () => loadLatest(),
			scene: ({ rev, content }) => enqueue(() => (rev > s.rev ? applyRemote(content, rev) : undefined)),
			snapshot: (data) => snapshot(data),
			problem: ({ message }) => {
				excalidrawAPI.setToast({ message, closable: true, duration: 6000 });
				setStatus("파일 오류");
			},
		};

		// WebSocket instead of SSE: SSE holds one of Chrome's 6 HTTP/1.1
		// connections per origin, so a 6th window would starve every save.
		let ws;
		let retry = 0;
		let closed = false;
		let timer;
		const connect = () => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			ws = new WebSocket(`${proto}://${location.host}/api/files/${FILE_ID}/ws?clientId=${CLIENT_ID}&token=${TOKEN}`);
			ws.onopen = () => (retry = 0);
			ws.onmessage = (m) => {
				const { event, data } = JSON.parse(m.data);
				handlers[event]?.(data);
			};
			ws.onclose = () => {
				if (closed) return;
				setStatus("연결 끊김, 재시도 중");
				timer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
			};
		};
		connect();
		return () => {
			closed = true;
			clearTimeout(timer);
			ws.close();
		};
	}, [excalidrawAPI]);

	const onChange = useCallback(
		(elements) => {
			if (!s.ready) return;
			if (sceneSig(elements) === s.lastSig) return;
			setStatus("변경됨");
			clearTimeout(s.saveTimer);
			s.saveTimer = setTimeout(
				() =>
					enqueue(() =>
						sceneSig(excalidrawAPI.getSceneElementsIncludingDeleted()) !== s.lastSig ? save() : undefined,
					),
				SAVE_DEBOUNCE_MS,
			);
		},
		[excalidrawAPI, save],
	);

	if (!FILE_ID || !TOKEN)
		return <p style={{ padding: 24 }}>file/token 파라미터가 없습니다. `excal open`으로 여세요.</p>;

	return (
		<Excalidraw
			excalidrawAPI={setAPI}
			onChange={onChange}
			langCode="ko-KR"
			UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
			renderTopRightUI={() => (
				<span
					style={{
						font: "12px system-ui",
						color: status === "동기화됨" ? "#2f9e44" : "#e8590c",
						padding: "0 8px",
						alignSelf: "center",
					}}
				>
					● {status}
				</span>
			)}
		/>
	);
}

createRoot(document.getElementById("root")).render(<App />);
