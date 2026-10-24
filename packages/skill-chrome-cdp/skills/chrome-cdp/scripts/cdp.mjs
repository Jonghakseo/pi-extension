#!/usr/bin/env node

// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

const TIMEOUT = 15000;
// Synchronous page script is terminated after this long so a runaway loop does
// not freeze the user's tab. Kept below TIMEOUT so the termination is reported
// before the CDP request itself times out.
const EVAL_SYNC_TIMEOUT = 12000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const IS_WINDOWS = process.platform === "win32";
if (!IS_WINDOWS) process.umask(0o077);
const RUNTIME_DIR = IS_WINDOWS
	? resolve(process.env.LOCALAPPDATA || resolve(homedir(), "AppData", "Local"), "cdp")
	: process.env.XDG_RUNTIME_DIR
		? resolve(process.env.XDG_RUNTIME_DIR, "cdp")
		: resolve(homedir(), ".cache", "cdp");
try {
	mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
} catch {}
const PAGES_CACHE = resolve(RUNTIME_DIR, "pages.json");

function sockPath(targetId) {
	return IS_WINDOWS ? `\\\\.\\pipe\\cdp-${targetId}` : resolve(RUNTIME_DIR, `cdp-${targetId}.sock`);
}

function getWsUrl() {
	const home = homedir();
	// macOS: ~/Library/Application Support/<name>/DevToolsActivePort
	const macBrowsers = [
		"Google/Chrome",
		"Google/Chrome Beta",
		"Google/Chrome for Testing",
		"Chromium",
		"BraveSoftware/Brave-Browser",
		"Microsoft Edge",
	];
	// Linux: ~/.config/<name>/DevToolsActivePort
	const linuxBrowsers = [
		"google-chrome",
		"google-chrome-beta",
		"chromium",
		"vivaldi",
		"vivaldi-snapshot",
		"BraveSoftware/Brave-Browser",
		"microsoft-edge",
	];
	// Linux Flatpak: ~/.var/app/<app-id>/config/<name>/DevToolsActivePort
	const flatpakBrowsers = [
		["org.chromium.Chromium", "chromium"],
		["com.google.Chrome", "google-chrome"],
		["com.brave.Browser", "BraveSoftware/Brave-Browser"],
		["com.microsoft.Edge", "microsoft-edge"],
		["com.vivaldi.Vivaldi", "vivaldi"],
	];
	const candidates = process.env.CDP_PORT_FILE
		? [process.env.CDP_PORT_FILE]
		: [
				...macBrowsers.flatMap((b) => [
					resolve(home, "Library/Application Support", b, "DevToolsActivePort"),
					resolve(home, "Library/Application Support", b, "Default/DevToolsActivePort"),
				]),
				...linuxBrowsers.flatMap((b) => [
					resolve(home, ".config", b, "DevToolsActivePort"),
					resolve(home, ".config", b, "Default/DevToolsActivePort"),
				]),
				...flatpakBrowsers.flatMap(([appId, name]) => [
					resolve(home, ".var/app", appId, "config", name, "DevToolsActivePort"),
					resolve(home, ".var/app", appId, "config", name, "Default/DevToolsActivePort"),
				]),
				// Windows: %LOCALAPPDATA%/<name>/User Data/DevToolsActivePort
				...(IS_WINDOWS
					? ["Google/Chrome", "BraveSoftware/Brave-Browser", "Microsoft/Edge"].flatMap((b) => {
							const base = process.env.LOCALAPPDATA || resolve(home, "AppData/Local");
							return [
								resolve(base, b, "User Data/DevToolsActivePort"),
								resolve(base, b, "User Data/Default/DevToolsActivePort"),
							];
						})
					: []),
			];
	const portFile = candidates.find((p) => existsSync(p));
	if (!portFile)
		throw new Error("No DevToolsActivePort found. Enable remote debugging at chrome://inspect/#remote-debugging");
	const lines = readFileSync(portFile, "utf8").trim().split("\n");
	if (lines.length < 2 || !lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
	const host = process.env.CDP_HOST || "127.0.0.1";
	return `ws://${host}:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePrefix(prefix, candidates, noun = "target", missingHint = "") {
	const upper = prefix.toUpperCase();
	const matches = candidates.filter((candidate) => candidate.toUpperCase().startsWith(upper));
	if (matches.length === 0) {
		const hint = missingHint ? ` ${missingHint}` : "";
		throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
	}
	if (matches.length > 1) {
		throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
	}
	return matches[0];
}

function getDisplayPrefixLength(targetIds) {
	if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
	const maxLen = Math.max(...targetIds.map((id) => id.length));
	for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
		const prefixes = new Set(targetIds.map((id) => id.slice(0, len).toUpperCase()));
		if (prefixes.size === targetIds.length) return len;
	}
	return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
	#ws;
	#id = 0;
	#pending = new Map();
	#eventHandlers = new Map();
	#closeHandlers = [];

	async connect(wsUrl) {
		return new Promise((res, rej) => {
			this.#ws = new WebSocket(wsUrl);
			this.#ws.onopen = () => res();
			this.#ws.onerror = (e) => rej(new Error("WebSocket error: " + (e.message || e.type)));
			this.#ws.onclose = () =>
				this.#closeHandlers.forEach((h) => {
					h();
				});
			this.#ws.onmessage = (ev) => {
				const msg = JSON.parse(ev.data);
				if (msg.id && this.#pending.has(msg.id)) {
					const { resolve, reject } = this.#pending.get(msg.id);
					this.#pending.delete(msg.id);
					if (msg.error) reject(new Error(msg.error.message));
					else resolve(msg.result);
				} else if (msg.method && this.#eventHandlers.has(msg.method)) {
					for (const handler of [...this.#eventHandlers.get(msg.method)]) {
						handler(msg.params || {}, msg);
					}
				}
			};
		});
	}

	send(method, params = {}, sessionId) {
		const id = ++this.#id;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			const msg = { id, method, params };
			if (sessionId) msg.sessionId = sessionId;
			this.#ws.send(JSON.stringify(msg));
			setTimeout(() => {
				if (this.#pending.has(id)) {
					this.#pending.delete(id);
					reject(new Error(`Timeout: ${method}`));
				}
			}, TIMEOUT);
		});
	}

	onEvent(method, handler) {
		if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
		const handlers = this.#eventHandlers.get(method);
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#eventHandlers.delete(method);
		};
	}

	waitForEvent(method, timeout = TIMEOUT) {
		let settled = false;
		let off;
		let timer;
		const promise = new Promise((resolve, reject) => {
			off = this.onEvent(method, (params) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				off();
				resolve(params);
			});
			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				off();
				reject(new Error(`Timeout waiting for event: ${method}`));
			}, timeout);
		});
		return {
			promise,
			cancel() {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				off?.();
			},
		};
	}

	onClose(handler) {
		this.#closeHandlers.push(handler);
	}
	close() {
		this.#ws.close();
	}
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
	const { targetInfos } = await cdp.send("Target.getTargets");
	return targetInfos.filter((t) => t.type === "page" && !t.url.startsWith("chrome://"));
}

function formatPageList(pages) {
	const prefixLen = getDisplayPrefixLength(pages.map((p) => p.targetId));
	return pages
		.map((p) => {
			const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
			const title = p.title.substring(0, 54).padEnd(54);
			return `${id}  ${title}  ${p.url}`;
		})
		.join("\n");
}

function shouldShowAxNode(node, compact = false) {
	const role = node.role?.value || "";
	const name = node.name?.value ?? "";
	const value = node.value?.value;
	if (compact && role === "InlineTextBox") return false;
	return role !== "none" && role !== "generic" && !(name === "" && (value === "" || value == null));
}

function formatAxNode(node, depth) {
	const role = node.role?.value || "";
	const name = node.name?.value ?? "";
	const value = node.value?.value;
	const indent = "  ".repeat(Math.min(depth, 10));
	let line = `${indent}[${role}]`;
	if (name !== "") line += ` ${name}`;
	if (!(value === "" || value == null)) line += ` = ${JSON.stringify(value)}`;
	return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
	const children = [];
	const seen = new Set();
	for (const childId of node.childIds || []) {
		const child = nodesById.get(childId);
		if (child && !seen.has(child.nodeId)) {
			seen.add(child.nodeId);
			children.push(child);
		}
	}
	for (const child of childrenByParent.get(node.nodeId) || []) {
		if (!seen.has(child.nodeId)) {
			seen.add(child.nodeId);
			children.push(child);
		}
	}
	return children;
}

async function snapshotStr(cdp, sid, compact = false) {
	const { nodes } = await cdp.send("Accessibility.getFullAXTree", {}, sid);
	const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
	const childrenByParent = new Map();
	for (const node of nodes) {
		if (!node.parentId) continue;
		if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
		childrenByParent.get(node.parentId).push(node);
	}

	const lines = [];
	const visited = new Set();
	function visit(node, depth) {
		if (!node || visited.has(node.nodeId)) return;
		visited.add(node.nodeId);
		if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
		for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
			visit(child, depth + 1);
		}
	}

	const roots = nodes.filter((node) => !node.parentId || !nodesById.has(node.parentId));
	for (const root of roots) visit(root, 0);
	for (const node of nodes) visit(node, 0);

	return lines.join("\n");
}

const TERMINATED_MESSAGE = `Script was stopped after ${EVAL_SYNC_TIMEOUT / 1000}s of synchronous execution (executionStopped: true). Changes it made before stopping remain.`;
const LATE_EFFECTS_MESSAGE = `Script did not finish within ${TIMEOUT / 1000}s (mayHaveLateEffects: true). It may have been stopped (synchronous code past ${EVAL_SYNC_TIMEOUT / 1000}s), may still be awaiting a promise, or may be blocked by a dialog. Check the page state before retrying anything with side effects.`;

async function evalStr(cdp, sid, expression) {
	await cdp.send("Runtime.enable", {}, sid);
	let result;
	const startedAt = Date.now();
	try {
		result = await cdp.send(
			"Runtime.evaluate",
			{
				expression,
				returnByValue: true,
				awaitPromise: true,
				// Terminates only the synchronous part; promise waits are not covered.
				timeout: EVAL_SYNC_TIMEOUT,
			},
			sid,
		);
	} catch (e) {
		// With awaitPromise, Chrome reports the termination as a generic "Internal error".
		// This mapping depends on current Chrome behavior; the elapsed-time check keeps
		// unrelated internal errors from being mislabeled.
		const terminated =
			e.message === "Execution was terminated" ||
			(e.message === "Internal error" && Date.now() - startedAt >= EVAL_SYNC_TIMEOUT - 500);
		if (terminated) throw new Error(TERMINATED_MESSAGE);
		if (e.message === "Timeout: Runtime.evaluate") throw new Error(LATE_EFFECTS_MESSAGE);
		throw e;
	}
	if (result.exceptionDetails) {
		const message = result.exceptionDetails.text || result.exceptionDetails.exception?.description;
		if (/Execution was terminated/.test(message || "")) throw new Error(TERMINATED_MESSAGE);
		throw new Error(message);
	}
	const val = result.result.value;
	return typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? "");
}

async function shotStr(cdp, sid, filePath, targetId) {
	// Get device scale factor so we can report coordinate mapping
	let dpr = 1;
	try {
		const metrics = await cdp.send("Page.getLayoutMetrics", {}, sid);
		dpr = metrics.visualViewport?.clientWidth
			? metrics.cssVisualViewport?.clientWidth
				? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
				: 1
			: 1;
		// Simpler: deviceScaleFactor is on the root Page metrics
		const { deviceScaleFactor } = await cdp.send("Emulation.getDeviceMetricsOverride", {}, sid).catch(() => ({}));
		if (deviceScaleFactor) dpr = deviceScaleFactor;
	} catch {}
	// Fallback: try to get DPR from JS
	if (dpr === 1) {
		try {
			const raw = await evalStr(cdp, sid, "window.devicePixelRatio");
			const parsed = parseFloat(raw);
			if (parsed > 0) dpr = parsed;
		} catch {}
	}

	const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
	const out = filePath || resolve(RUNTIME_DIR, `screenshot-${(targetId || "unknown").slice(0, 8)}.png`);
	writeFileSync(out, Buffer.from(data, "base64"));

	const lines = [out];
	lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
	lines.push(`Coordinate mapping:`);
	lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
	lines.push(
		`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`,
	);
	if (dpr !== 1) {
		lines.push(
			`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100 / dpr) / 100}`,
		);
	}
	return lines.join("\n");
}

async function htmlStr(cdp, sid, selector) {
	const expr = selector
		? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
		: `document.documentElement.outerHTML`;
	return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
	const deadline = Date.now() + timeoutMs;
	let lastState = "";
	let lastError;
	while (Date.now() < deadline) {
		try {
			const state = await evalStr(cdp, sid, "document.readyState");
			lastState = state;
			if (state === "complete") return;
		} catch (e) {
			lastError = e;
		}
		await sleep(200);
	}

	if (lastState) {
		throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
	}
	if (lastError) {
		throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
	}
	throw new Error("Timed out waiting for navigation to finish");
}

async function navStr(cdp, sid, url) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			throw new Error(`Only http/https URLs allowed, got: ${url}`);
	} catch (e) {
		if (e.message.startsWith("Only")) throw e;
		throw new Error(`Invalid URL: ${url}`);
	}
	await cdp.send("Page.enable", {}, sid);
	const loadEvent = cdp.waitForEvent("Page.loadEventFired", NAVIGATION_TIMEOUT);
	const result = await cdp.send("Page.navigate", { url }, sid);
	if (result.errorText) {
		loadEvent.cancel();
		throw new Error(result.errorText);
	}
	if (result.loaderId) {
		await loadEvent.promise;
	} else {
		loadEvent.cancel();
	}
	await waitForDocumentReady(cdp, sid, 5000);
	return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
	const raw = await evalStr(
		cdp,
		sid,
		`JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`,
	);
	return JSON.parse(raw)
		.map(
			(e) =>
				`${String(e.duration).padStart(5)}ms  ${String(e.size || "?").padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`,
		)
		.join("\n");
}

// Page-side helpers shared by the click hit-test, its recheck, and its verification.
const PAGE_HELPERS = `
      const describe = (n) => {
        if (!n) return 'nothing';
        let s = n.tagName ? n.tagName.toLowerCase() : String(n.nodeName);
        if (n.id) s += '#' + n.id;
        if (typeof n.className === 'string' && n.className.trim()) s += '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.');
        return s;
      };
      const parentOf = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
      const deepHit = (x, y) => {
        let hit = document.elementFromPoint(x, y);
        while (hit && hit.shadowRoot) {
          const inner = hit.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === hit) break;
          hit = inner;
        }
        return hit;
      };
`;

function assertLive(ctx) {
	if (ctx.cancelled) throw new Error("Cancelled: a JavaScript dialog opened before the input was sent");
}

// Click element by CSS selector.
// Uses real mouse input at the element center when a hit-test proves the click
// lands on the element itself, then checks whether the click reached it. Otherwise
// falls back to el.click(), the previous behavior, so covered, zero-size, or
// wrapper targets behave as before. The hit-test never clicks; the input is sent
// only after ctx.cancelled has been checked, so a dialog cannot cause a ghost click.
// Outcomes: verified success, "UNVERIFIED:" (input sent, effect not confirmed, an
// ok result so the caller does not retry blindly), or an error meaning no input was sent.
async function clickStr(cdp, sid, selector, ctx) {
	if (!selector) throw new Error("CSS selector required");
	const sel = JSON.stringify(selector);
	// Unique per command so parallel clicks cannot overwrite each other's probe.
	const key = JSON.stringify(`__cdpClickProbe_${randomBytes(6).toString("hex")}`);
	const expr = `
    (async function() {
      const el = document.querySelector(${sel});
      if (!el) return { ok: false, error: 'Element not found: ' + ${sel} };
      if (el.matches(':disabled')) return { ok: false, error: 'Element is disabled: ' + ${sel} };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const info = { ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) };
      ${PAGE_HELPERS}
      const jsMode = (reason) => ({ ...info, mode: 'js', reason });
      // Native pickers (select popup, file/color chooser) open on real mouse
      // input but not on el.click(); keep the old behavior for them.
      if (el.matches('select, option, input[type=file], input[type=color]')) return jsMode('native picker control');
      if (window.visualViewport && window.visualViewport.scale !== 1) return jsMode('page is pinch-zoomed');
      // Let sticky headers and lazy layout settle after the scroll. Hidden tabs
      // pause requestAnimationFrame, so they skip the wait instead of stalling.
      const frame = () => document.hidden ? Promise.resolve() : new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 100); });
      await frame();
      await frame();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return jsMode('element has no size');
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return jsMode('center is outside the viewport');
      const hit = deepHit(x, y);
      // Nodes inside el's own shadow tree are part of el itself, not a nested control.
      const inOwnShadow = (n) => {
        let root = n.getRootNode && n.getRootNode();
        while (root && root.host) {
          if (root.host === el) return true;
          root = root.host.getRootNode();
        }
        return false;
      };
      const interactive = 'a[href], button, input, select, textarea, label, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [onclick]';
      let cur = hit;
      let nested = null;
      while (cur && cur !== el) {
        if (!nested && cur.matches && cur.matches(interactive) && !inOwnShadow(cur)) nested = cur;
        cur = parentOf(cur);
      }
      if (cur !== el) return jsMode('center is covered by ' + describe(hit));
      // A real click would activate the nested control instead of el.
      if (nested) return jsMode('center hits nested ' + describe(nested));
      // Probe so the verification step can tell whether the click reached el. It
      // listens on window in the capture phase, so an ancestor that stops
      // propagation cannot hide the event. It removes itself after 30s.
      const key = ${key};
      if (window[key]) window[key].remove();
      const flags = { mousedown: false, click: false };
      const seen = (name) => (ev) => {
        if (ev.composedPath && ev.composedPath().includes(el)) flags[name] = true;
      };
      const onDown = seen('mousedown');
      const onClick = seen('click');
      window.addEventListener('mousedown', onDown, true);
      window.addEventListener('click', onClick, true);
      const probe = {
        el,
        flags,
        remove() {
          clearTimeout(timer);
          window.removeEventListener('mousedown', onDown, true);
          window.removeEventListener('click', onClick, true);
          if (window[key] === probe) delete window[key];
        },
      };
      const timer = setTimeout(() => probe.remove(), 30000);
      window[key] = probe;
      return { ...info, mode: 'mouse', x, y };
    })()
  `;
	let probeInstalled = false;
	try {
		let r = JSON.parse(await evalStr(cdp, sid, expr));
		if (!r.ok) throw new Error(r.error);
		assertLive(ctx);
		probeInstalled = r.mode === "mouse";

		if (probeInstalled) {
			// Layout can shift between the hit-test and the input (late banners, lazy
			// images). Recheck right before sending; if the target moved, use el.click().
			const recheckExpr = `(function() {
      const p = window[${key}];
      const moved = () => { if (p) p.remove(); return { ok: false }; };
      if (!p || !p.el.isConnected) return moved();
      ${PAGE_HELPERS}
      let cur = deepHit(${r.x}, ${r.y});
      while (cur && cur !== p.el) cur = parentOf(cur);
      return cur === p.el ? { ok: true } : moved();
    })()`;
			const re = JSON.parse(await evalStr(cdp, sid, recheckExpr));
			assertLive(ctx);
			if (!re.ok) {
				probeInstalled = false;
				r = { ...r, mode: "js", reason: "target moved before the click" };
			}
		}

		const label = `Clicked <${r.tag}> "${r.text}"`;
		if (r.mode === "js") {
			const jsExpr = `(function() {
      const el = document.querySelector(${sel});
      if (!el) return { ok: false, error: 'Element not found: ' + ${sel} };
      el.click();
      return { ok: true };
    })()`;
			ctx.dispatched = true;
			const res = JSON.parse(await evalStr(cdp, sid, jsExpr));
			if (!res.ok) throw new Error(res.error);
			return `${label} (el.click(): ${r.reason})`;
		}

		await dispatchClick(cdp, sid, r.x, r.y, ctx);
		if (ctx.cancelled) return "";
		const at = `CSS ${Math.round(r.x)},${Math.round(r.y)}`;
		const verifyExpr = `(function() {
      const p = window[${key}];
      if (!p) return { probe: false };
      p.remove();
      ${PAGE_HELPERS}
      return { probe: true, mousedown: p.flags.mousedown, click: p.flags.click, top: describe(deepHit(${r.x}, ${r.y})) };
    })()`;
		// The verification eval removes the probe, or the 30s expiry does if it fails.
		probeInstalled = false;
		let v;
		try {
			v = JSON.parse(await evalStr(cdp, sid, verifyExpr));
		} catch (e) {
			return `${label} (mouse at ${at}; verification failed: ${e.message})`;
		}
		if (!v.probe) return `${label} (mouse at ${at}; page changed before verification, effect not confirmed)`;
		if (v.click) return `${label} (mouse at ${at})`;
		if (v.mousedown) {
			return `${label} (mouse at ${at}; mousedown reached the element but no click event fired)`;
		}
		// Not an error: the input was sent, and an error would invite a blind retry.
		return `UNVERIFIED: mouse input was sent at ${at} but no click event was observed on <${r.tag.toLowerCase()}> "${r.text}" (the topmost element there is now ${v.top}). Do not repeat the click blindly; check the page state first.`;
	} finally {
		// Best effort: a dialog opened by this command leaves cleanup to the 30s expiry.
		if (probeInstalled && !ctx.cancelled) {
			await evalStr(cdp, sid, `(function() { const p = window[${key}]; if (p) p.remove(); })()`).catch(() => {});
		}
	}
}

// Old-style click: el.click() only, no mouse input. Use when real mouse input
// misbehaves or the layout keeps moving.
async function clickJsStr(cdp, sid, selector, ctx) {
	if (!selector) throw new Error("CSS selector required");
	const sel = JSON.stringify(selector);
	ctx.dispatched = true;
	const r = JSON.parse(
		await evalStr(
			cdp,
			sid,
			`(function() {
      const el = document.querySelector(${sel});
      if (!el) return { ok: false, error: 'Element not found: ' + ${sel} };
      if (el.matches(':disabled')) return { ok: false, error: 'Element is disabled: ' + ${sel} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) };
    })()`,
		),
	);
	if (!r.ok) throw new Error(r.error);
	return `Clicked <${r.tag}> "${r.text}"`;
}

// If a mousedown handler opens a dialog, the mousePressed response only arrives once
// the dialog is handled, and a release sent meanwhile is dropped. So the release
// waits for the press to settle (success or failure) and is always sent after it,
// otherwise the button stays pressed in the page.
async function dispatchClick(cdp, sid, x, y, ctx) {
	const base = { x, y, button: "left", clickCount: 1, modifiers: 0 };
	const send = (type) => cdp.send("Input.dispatchMouseEvent", { ...base, type }, sid);
	await send("mouseMoved");
	if (ctx.cancelled) return;
	ctx.dispatched = true;
	const pressed = send("mousePressed");
	pressed.catch(() => {});
	await sleep(50);
	const pressResult = (await Promise.allSettled([pressed]))[0];
	await send("mouseReleased");
	if (pressResult.status === "rejected") throw pressResult.reason;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y, ctx) {
	const cx = parseFloat(x);
	const cy = parseFloat(y);
	if (Number.isNaN(cx) || Number.isNaN(cy)) throw new Error("x and y must be numbers (CSS pixels)");
	await dispatchClick(cdp, sid, cx, cy, ctx);
	return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text, ctx) {
	if (text == null || text === "") throw new Error("text required");
	ctx.dispatched = true;
	await cdp.send("Input.insertText", { text }, sid);
	return `Typed ${text.length} characters`;
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500, ctx) {
	if (!selector) throw new Error("CSS selector required");
	let clicks = 0;
	const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
	while (Date.now() < deadline && !ctx.cancelled) {
		const exists = await evalStr(cdp, sid, `!!document.querySelector(${JSON.stringify(selector)})`);
		if (exists !== "true" || ctx.cancelled) break;
		const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
		ctx.dispatched = true;
		const clicked = await evalStr(cdp, sid, clickExpr);
		if (clicked !== "true") break;
		clicks++;
		ctx.progress = clicks;
		if (ctx.cancelled) break;
		await sleep(intervalMs);
	}
	return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
	if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
	let params = {};
	if (paramsJson) {
		try {
			params = JSON.parse(paramsJson);
		} catch {
			throw new Error(`Invalid JSON params: ${paramsJson}`);
		}
	}
	const result = await cdp.send(method, params, sid);
	return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
	const sp = sockPath(targetId);

	const cdp = new CDP();
	try {
		await cdp.connect(getWsUrl());
	} catch (e) {
		process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
		process.exit(1);
	}

	let sessionId;
	try {
		const res = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
		sessionId = res.sessionId;
	} catch (e) {
		process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
		cdp.close();
		process.exit(1);
	}

	// Track JS dialogs. Page must be enabled before a dialog opens, otherwise
	// Page.handleJavaScriptDialog reports "No dialog is showing" and the tab
	// stays blocked for every Runtime call.
	let openDialog = null;
	// Bumped on every opening so a late "handled" reply cannot clear a newer dialog.
	let dialogGen = 0;
	cdp.onEvent("Page.javascriptDialogOpening", (params, msg) => {
		if (msg.sessionId !== sessionId) return;
		dialogGen++;
		openDialog = { type: params.type, message: params.message };
	});
	cdp.onEvent("Page.javascriptDialogClosed", (_params, msg) => {
		if (msg.sessionId === sessionId) openDialog = null;
	});
	// Not awaited: if a dialog is already open, Page.enable blocks until it is
	// handled, and the CLI only waits a few seconds for the daemon socket.
	cdp.send("Page.enable", {}, sessionId).catch(() => {});

	const DIALOG_HINT = `Handle it with: evalraw <target> Page.handleJavaScriptDialog '{"accept":false}' (or {"accept":true})`;
	const describeDialog = (d) => `JavaScript ${d.type} dialog ${JSON.stringify(String(d.message ?? "").slice(0, 200))}`;
	// Every page command except evalraw hangs while a dialog is open, so they fail fast.
	const DIALOG_BLOCKED = new Set([
		"eval",
		"html",
		"net",
		"network",
		"click",
		"clickjs",
		"clickxy",
		"type",
		"loadall",
		"snap",
		"snapshot",
		"shot",
		"screenshot",
		"nav",
		"navigate",
	]);
	// Commands that may open a dialog themselves. They return as soon as it opens
	// instead of hanging until the CDP timeout.
	const DIALOG_RACED = new Set(["eval", "click", "clickjs", "clickxy", "type", "loadall"]);

	// ctx is shared with the command: the dialog listener sets ctx.cancelled
	// synchronously so the command can stop before sending any further input, and
	// the command sets ctx.dispatched once input that may trigger the action is sent.
	async function raceDialog(cmd, ctx, work) {
		let off;
		const opened = new Promise((res) => {
			off = cdp.onEvent("Page.javascriptDialogOpening", (params, msg) => {
				if (msg.sessionId !== sessionId) return;
				ctx.cancelled = true;
				res(params);
			});
		});
		const running = work();
		// If the dialog wins, the original request may reject later; swallow it.
		running.catch(() => {});
		try {
			const winner = await Promise.race([running.then((value) => ({ value })), opened.then((dialog) => ({ dialog }))]);
			if (!winner.dialog) return winner.value;
			const what = describeDialog(winner.dialog);
			if (cmd === "eval") {
				throw new Error(
					`Script paused: a ${what} opened, so no result is available. Once the dialog is handled the script resumes and may still change the page.\n${DIALOG_HINT}`,
				);
			}
			if (!ctx.dispatched) {
				throw new Error(
					`A ${what} opened before the input was sent. The action was NOT performed and will not be sent later. Handle the dialog, then re-check the page state before retrying.\n${DIALOG_HINT}`,
				);
			}
			// Input was sent (or may have been). Report an ok result, not a failure, so callers do not retry blindly.
			const progress =
				cmd === "loadall"
					? ` loadall stopped after ${ctx.progress ?? 0} completed click(s); one more click may have been in flight.`
					: "";
			return `Input was sent, then a ${what} opened.${progress} The page may have triggered the dialog, or the dialog may have dropped the input; how it was handled is unknown. Do not repeat the action blindly: handle the dialog, then check the page state before deciding whether to repeat. The page is blocked until the dialog is handled.\n${DIALOG_HINT}`;
		} finally {
			off();
		}
	}

	// Shutdown helpers
	let alive = true;
	function shutdown() {
		if (!alive) return;
		alive = false;
		server.close();
		if (!IS_WINDOWS)
			try {
				unlinkSync(sp);
			} catch {}
		cdp.close();
		process.exit(0);
	}

	// Exit if target goes away or Chrome disconnects
	cdp.onEvent("Target.targetDestroyed", (params) => {
		if (params.targetId === targetId) shutdown();
	});
	cdp.onEvent("Target.detachedFromTarget", (params) => {
		if (params.sessionId === sessionId) shutdown();
	});
	cdp.onClose(() => shutdown());
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	// Idle timer
	let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
	function resetIdle() {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
	}

	// Run one page command and return its output string
	async function runCommand(cmd, args, ctx) {
		switch (cmd) {
			case "list":
				return formatPageList(await getPages(cdp));
			case "list_raw":
				return JSON.stringify(await getPages(cdp));
			case "snap":
			case "snapshot":
				return snapshotStr(cdp, sessionId, true);
			case "eval":
				return evalStr(cdp, sessionId, args[0]);
			case "shot":
			case "screenshot":
				return shotStr(cdp, sessionId, args[0], targetId);
			case "html":
				return htmlStr(cdp, sessionId, args[0]);
			case "nav":
			case "navigate":
				return navStr(cdp, sessionId, args[0]);
			case "net":
			case "network":
				return netStr(cdp, sessionId);
			case "click":
				return clickStr(cdp, sessionId, args[0], ctx);
			case "clickxy":
				return clickXyStr(cdp, sessionId, args[0], args[1], ctx);
			case "type":
				return typeStr(cdp, sessionId, args[0], ctx);
			case "clickjs":
				return clickJsStr(cdp, sessionId, args[0], ctx);
			case "loadall":
				return loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1], 10) : 1500, ctx);
			case "evalraw": {
				const handlesDialog = args[0] === "Page.handleJavaScriptDialog";
				const genAtRequest = dialogGen;
				try {
					const out = await evalRawStr(cdp, sessionId, args[0], args[1]);
					if (handlesDialog && genAtRequest === dialogGen) openDialog = null;
					return out;
				} catch (e) {
					// Keep the flag on other failures (e.g. timeout): the dialog may still be open.
					// Also keep it if another dialog opened meanwhile (alert(1); alert(2)).
					if (handlesDialog && genAtRequest === dialogGen && /No dialog is showing/i.test(e.message)) openDialog = null;
					throw e;
				}
			}
		}
		return undefined;
	}

	const KNOWN_COMMANDS = new Set([
		"list",
		"list_raw",
		"snap",
		"snapshot",
		"eval",
		"shot",
		"screenshot",
		"html",
		"nav",
		"navigate",
		"net",
		"network",
		"click",
		"clickjs",
		"clickxy",
		"type",
		"loadall",
		"evalraw",
	]);

	// Handle a command
	// Input commands share one mouse/keyboard state per tab. Running two at once
	// interleaves their press/release events so neither click lands, so they run
	// one at a time. The queue waits for the reported result (which returns early
	// when a dialog opens), never for work blocked behind a dialog, so evalraw
	// Page.handleJavaScriptDialog is never queued behind a stuck input.
	const INPUT_COMMANDS = new Set(["click", "clickjs", "clickxy", "type", "loadall"]);
	let inputQueue = Promise.resolve();

	function handleCommand(req) {
		if (!INPUT_COMMANDS.has(req.cmd)) return executeCommand(req);
		const run = inputQueue.then(() => executeCommand(req));
		inputQueue = run.catch(() => {});
		return run;
	}

	async function executeCommand({ cmd, args }) {
		resetIdle();
		if (cmd === "stop") return { ok: true, result: "", stopAfter: true };
		if (!KNOWN_COMMANDS.has(cmd)) return { ok: false, error: `Unknown command: ${cmd}` };
		if (openDialog && DIALOG_BLOCKED.has(cmd)) {
			return { ok: false, error: `A ${describeDialog(openDialog)} is open and blocks this command.\n${DIALOG_HINT}` };
		}
		try {
			const ctx = { dispatched: false, cancelled: false, progress: 0 };
			const work = () => runCommand(cmd, args, ctx);
			const result = DIALOG_RACED.has(cmd) ? await raceDialog(cmd, ctx, work) : await work();
			return { ok: true, result: result ?? "" };
		} catch (e) {
			let error = e.message;
			if (openDialog && !error.includes("Page.handleJavaScriptDialog")) {
				error += `\nA ${describeDialog(openDialog)} is blocking the page.\n${DIALOG_HINT}`;
			}
			return { ok: false, error };
		}
	}

	// Unix socket server — NDJSON protocol
	// Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
	// Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
	// Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
	//           or { "id": <number>, "ok": false, "error": "<message>" }
	const server = net.createServer((conn) => {
		let buf = "";
		conn.on("data", (chunk) => {
			buf += chunk.toString();
			const lines = buf.split("\n");
			buf = lines.pop(); // keep incomplete last line
			for (const line of lines) {
				if (!line.trim()) continue;
				let req;
				try {
					req = JSON.parse(line);
				} catch {
					conn.write(JSON.stringify({ ok: false, error: "Invalid JSON request", id: null }) + "\n");
					continue;
				}
				handleCommand(req).then((res) => {
					const payload = JSON.stringify({ ...res, id: req.id }) + "\n";
					if (res.stopAfter) conn.end(payload, shutdown);
					else conn.write(payload);
				});
			}
		});
	});

	server.on("error", (e) => {
		process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
		process.exit(1);
	});

	if (!IS_WINDOWS)
		try {
			unlinkSync(sp);
		} catch {}
	server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
	return new Promise((resolve, reject) => {
		const conn = net.connect(sp);
		conn.on("connect", () => resolve(conn));
		conn.on("error", reject);
	});
}

async function getOrStartTabDaemon(targetId) {
	const sp = sockPath(targetId);
	// Try existing daemon
	try {
		return await connectToSocket(sp);
	} catch {}

	// Clean stale socket
	if (!IS_WINDOWS)
		try {
			unlinkSync(sp);
		} catch {}

	// Spawn daemon
	const child = spawn(process.execPath, [process.argv[1], "_daemon", targetId], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();

	// Wait for socket (includes time for user to click Allow)
	for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
		await sleep(DAEMON_CONNECT_DELAY);
		try {
			return await connectToSocket(sp);
		} catch {}
	}
	throw new Error("Daemon failed to start — did you click Allow in Chrome?");
}

function sendCommand(conn, req) {
	return new Promise((resolve, reject) => {
		let buf = "";
		let settled = false;

		const cleanup = () => {
			conn.off("data", onData);
			conn.off("error", onError);
			conn.off("end", onEnd);
			conn.off("close", onClose);
		};

		const onData = (chunk) => {
			buf += chunk.toString();
			const idx = buf.indexOf("\n");
			if (idx === -1) return;
			settled = true;
			cleanup();
			resolve(JSON.parse(buf.slice(0, idx)));
			conn.end();
		};

		const onError = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error("Connection closed before response"));
		};

		const onClose = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error("Connection closed before response"));
		};

		conn.on("data", onData);
		conn.on("error", onError);
		conn.on("end", onEnd);
		conn.on("close", onClose);
		req.id = 1;
		conn.write(JSON.stringify(req) + "\n");
	});
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
	if (!existsSync(PAGES_CACHE)) return;
	const pages = JSON.parse(readFileSync(PAGES_CACHE, "utf8"));
	const targets = targetPrefix
		? [
				resolvePrefix(
					targetPrefix,
					pages.map((p) => p.targetId),
					"target",
				),
			]
		: pages.map((p) => p.targetId);

	for (const targetId of targets) {
		const sp = sockPath(targetId);
		try {
			const conn = await connectToSocket(sp);
			await sendCommand(conn, { cmd: "stop" });
		} catch {
			if (!IS_WINDOWS)
				try {
					unlinkSync(sp);
				} catch {}
		}
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

  list                              List open pages (shows unique target prefixes)
  snap  <target>                    Accessibility tree snapshot
  eval  <target> <expr>             Evaluate JS expression. Synchronous code is stopped after 12s;
                                    a promise still pending after 15s is reported (it may keep running)
  shot  <target> [file]             Screenshot (default: screenshot-<target>.png in runtime dir); prints coordinate mapping
  html  <target> [selector]         Get HTML (full page or CSS selector)
  nav   <target> <url>              Navigate to URL and wait for load completion
  net   <target>                    Network performance entries
  click   <target> <selector>       Click an element by CSS selector. Uses real mouse input when the
                                    element center is hit-testable and checks that the click reached the
                                    element (UNVERIFIED: means input was sent but not confirmed, do not
                                    repeat blindly), otherwise falls back to el.click(). Disabled elements error
  clickjs <target> <selector>       Old-style click: el.click() only, no mouse input. Use when real mouse
                                    input misbehaves or the layout keeps moving
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  loadall <target> <selector> [ms]  Repeatedly click a "load more" button until it disappears
                                    Optional interval in ms between clicks (default 1500)
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  open  [url]                       Open a new tab (default: about:blank)
                                    Note: each new tab triggers a fresh "Allow debugging?" prompt
  stop  [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

JAVASCRIPT DIALOGS
  If eval/click/clickjs/clickxy/type/loadall opens alert/confirm/prompt, the command
  returns at once and names the dialog. A click that hit the dialog BEFORE its input
  was sent reports an error and is NOT performed; once the input was sent it reports
  an ok result saying the input may have been dropped by the dialog (check the page
  state before repeating it). While a dialog is open every page command except
  evalraw/list/stop fails fast. Handle it with:
    evalraw <target> Page.handleJavaScriptDialog '{"accept":false}'
  A dialog that was already open before the tab's daemon started cannot be
  handled from raw mode; ask the user to close it in Chrome.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket in the runtime dir (see below).
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI: snap, eval, shot, html, nav, net, click, clickjs, clickxy,
  type, loadall, evalraw, stop. Use evalraw to send arbitrary CDP methods.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
	"snap",
	"snapshot",
	"eval",
	"shot",
	"screenshot",
	"html",
	"nav",
	"navigate",
	"net",
	"network",
	"click",
	"clickjs",
	"clickxy",
	"type",
	"loadall",
	"evalraw",
]);

async function main() {
	if (typeof WebSocket === "undefined") {
		throw new Error(
			`cdp.mjs requires Node 22+ (built-in WebSocket). Current: ${process.version}. Upgrade Node or use the chrome-devtools CLI instead.`,
		);
	}
	const [cmd, ...args] = process.argv.slice(2);

	// Daemon mode (internal)
	if (cmd === "_daemon") {
		await runDaemon(args[0]);
		return;
	}

	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
		console.log(USAGE);
		process.exit(0);
	}

	if (cmd === "list" || cmd === "ls") {
		const cdp = new CDP();
		await cdp.connect(getWsUrl());
		const pages = await getPages(cdp);
		cdp.close();
		writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
		console.log(formatPageList(pages));
		setTimeout(() => process.exit(0), 100);
		return;
	}

	// Open new tab
	if (cmd === "open") {
		const url = args[0] || "about:blank";
		const cdp = new CDP();
		await cdp.connect(getWsUrl());
		const { targetId } = await cdp.send("Target.createTarget", { url });
		// Refresh cache; new tab may not appear in getTargets immediately, so add it manually
		const pages = await getPages(cdp);
		if (!pages.some((p) => p.targetId === targetId)) {
			pages.push({ targetId, title: url, url });
		}
		cdp.close();
		writeFileSync(PAGES_CACHE, JSON.stringify(pages), { mode: 0o600 });
		console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
		console.log('Note: this tab will need "Allow debugging?" approval on first access.');
		return;
	}

	// Stop
	if (cmd === "stop") {
		await stopDaemons(args[0]);
		return;
	}

	// Page commands — need target prefix
	if (!NEEDS_TARGET.has(cmd)) {
		console.error(`Unknown command: ${cmd}\n`);
		console.log(USAGE);
		process.exit(1);
	}

	const targetPrefix = args[0];
	if (!targetPrefix) {
		console.error('Error: target ID required. Run "cdp list" first.');
		process.exit(1);
	}

	// Resolve prefix → full targetId from pages cache
	if (!existsSync(PAGES_CACHE)) {
		console.error('No page list cached. Run "cdp list" first.');
		process.exit(1);
	}
	const pages = JSON.parse(readFileSync(PAGES_CACHE, "utf8"));
	const targetId = resolvePrefix(
		targetPrefix,
		pages.map((p) => p.targetId),
		"target",
		'Run "cdp list".',
	);

	const conn = await getOrStartTabDaemon(targetId);

	const cmdArgs = args.slice(1);

	if (cmd === "eval") {
		const expr = cmdArgs.join(" ");
		if (!expr) {
			console.error("Error: expression required");
			process.exit(1);
		}
		cmdArgs[0] = expr;
	} else if (cmd === "type") {
		// Join all remaining args as text (allows spaces)
		const text = cmdArgs.join(" ");
		if (!text) {
			console.error("Error: text required");
			process.exit(1);
		}
		cmdArgs[0] = text;
	} else if (cmd === "evalraw") {
		// args: [method, ...jsonParts] — join json parts in case of spaces
		if (!cmdArgs[0]) {
			console.error("Error: CDP method required");
			process.exit(1);
		}
		if (cmdArgs.length > 2) cmdArgs[1] = cmdArgs.slice(1).join(" ");
	}

	if ((cmd === "nav" || cmd === "navigate") && !cmdArgs[0]) {
		console.error("Error: URL required");
		process.exit(1);
	}

	const response = await sendCommand(conn, { cmd, args: cmdArgs });

	if (response.ok) {
		if (response.result) console.log(response.result);
	} else {
		console.error("Error:", response.error);
		process.exitCode = 1;
	}
}

main().catch((e) => {
	console.error(e.message);
	if (e.message.includes("No DevToolsActivePort found")) {
		console.error("For a custom profile, set CDP_PORT_FILE=<user-data-dir>/DevToolsActivePort.");
	}
	process.exit(1);
});
