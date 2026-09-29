import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

/** Elements written by the LLM in skeleton form have no numeric `version`. */
export const isSkeleton = (el) => typeof el?.version !== "number";

const ARROW_GAP = 6;

function edgeT(shape, dx, dy) {
	const hw = shape.width / 2;
	const hh = shape.height / 2;
	if (shape.type === "ellipse") return 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
	if (shape.type === "diamond") return 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
	// rectangle / text / everything else: bounding box
	return Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);

const hasBox = (el) =>
	el && [el.x, el.y, el.width, el.height].every((v) => typeof v === "number" && Number.isFinite(v));

/**
 * Skeleton arrows that only name `start.id` / `end.id` (no x/y) get coordinates
 * computed from the two shapes: centre-to-centre, clipped at each shape's edge.
 */
export function autoRouteArrow(arrow, byId) {
	if (arrow.type !== "arrow" && arrow.type !== "line") return arrow;
	if (typeof arrow.x === "number" && typeof arrow.y === "number") return arrow;
	const a = byId.get(arrow.start?.id);
	const b = byId.get(arrow.end?.id);
	if (!hasBox(a) || !hasBox(b)) return arrow;
	const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
	const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	const dx = cb.x - ca.x;
	const dy = cb.y - ca.y;
	const len = Math.hypot(dx, dy) || 1;
	const ux = dx / len;
	const uy = dy / len;
	const ta = edgeT(a, dx, dy) * len + ARROW_GAP;
	const tb = edgeT(b, -dx, -dy) * len + ARROW_GAP;
	const sx = ca.x + ux * ta;
	const sy = ca.y + uy * ta;
	const ex = cb.x - ux * tb;
	const ey = cb.y - uy * tb;
	return {
		...arrow,
		x: sx,
		y: sy,
		width: Math.abs(ex - sx),
		height: Math.abs(ey - sy),
		points: [
			[0, 0],
			[ex - sx, ey - sy],
		],
	};
}

function mergeBound(a, b) {
	const out = [...(a || [])];
	for (const item of b || []) if (!out.some((x) => x.id === item.id)) out.push(item);
	return out.length ? out : null;
}

/**
 * Convert skeleton elements (possibly mixed with full elements) into full
 * Excalidraw elements. Full elements are passed through untouched except for
 * `boundElements`, which receives bindings created by skeleton arrows/labels.
 */
export function convertMixed(input) {
	// An element rewritten as a skeleton (version removed) with a new `label`
	// replaces its old bound text.
	const relabeled = new Set(input.filter((e) => isSkeleton(e) && e.id && e.label).map((e) => e.id));
	const elements = input.filter((e) => !(e.type === "text" && !isSkeleton(e) && relabeled.has(e.containerId)));
	const byId = new Map(elements.filter((e) => e.id).map((e) => [e.id, e]));
	const prepared = elements.map((el) => {
		if (isSkeleton(el)) return autoRouteArrow(el, byId);
		// Full frames carry membership in their children's `frameId`, not in
		// `children`; the converter iterates `children` unguarded.
		if ((el.type === "frame" || el.type === "magicframe") && !Array.isArray(el.children))
			return { ...el, children: [] };
		return el;
	});
	const converted = convertToExcalidrawElements(prepared, { regenerateIds: false });
	const originals = new Map(elements.filter((e) => !isSkeleton(e)).map((e) => [e.id, e]));
	return converted.map((c) => {
		const orig = originals.get(c.id);
		if (!orig) return c;
		return {
			...orig,
			boundElements: mergeBound(orig.boundElements, c.boundElements),
			// a skeleton frame may adopt existing full elements
			frameId: c.frameId ?? orig.frameId ?? null,
		};
	});
}

function distToBox(px, py, el) {
	const dx = Math.max(el.x - px, 0, px - (el.x + el.width));
	const dy = Math.max(el.y - py, 0, py - (el.y + el.height));
	return Math.hypot(dx, dy);
}

/**
 * Post-processing for full elements edited by hand (before restoreElements):
 * - straight bound arrows whose endpoints drifted away from their shapes
 *   (because a shape was moved in the file) are re-routed;
 * - shapes get back-references to arrows bound to them, and bound texts to
 *   their containers, so Excalidraw keeps them attached when dragging.
 */
const geom = (e) => (e ? [e.x, e.y, e.width, e.height].map((v) => Math.round(v ?? 0)).join(",") : "");

export function repairScene(elements, prevElements = []) {
	const byId = new Map(elements.map((e) => [e.id, e]));
	const prev = new Map(prevElements.map((e) => [e.id, e]));
	const arrowGeom = (e) => (e ? geom(e) + JSON.stringify(e.points) : "");
	let changed = false;
	const out = elements.map((el) => {
		if (el.isDeleted || el.type !== "arrow" || el.points?.length !== 2) return el;
		const a = byId.get(el.startBinding?.elementId);
		const b = byId.get(el.endBinding?.elementId);
		if (!hasBox(a) || !hasBox(b)) return el;
		const [p0, p1] = el.points;
		const far = distToBox(el.x + p0[0], el.y + p0[1], a) > 30 || distToBox(el.x + p1[0], el.y + p1[1], b) > 30;
		// a bound shape moved in the file while the arrow itself was left untouched
		const pa = prev.get(el.id);
		const shapeMoved =
			pa &&
			arrowGeom(pa) === arrowGeom(el) &&
			((prev.has(a.id) && geom(prev.get(a.id)) !== geom(a)) || (prev.has(b.id) && geom(prev.get(b.id)) !== geom(b)));
		if (!far && !shapeMoved) return el;
		const routed = autoRouteArrow({ type: "arrow", start: { id: a.id }, end: { id: b.id } }, byId);
		changed = true;
		return { ...el, x: routed.x, y: routed.y, width: routed.width, height: routed.height, points: routed.points };
	});
	const outById = new Map(out.map((e) => [e.id, e]));
	const addRef = (targetId, ref) => {
		const t = outById.get(targetId);
		if (!t || (t.boundElements || []).some((b) => b.id === ref.id)) return;
		const next = { ...t, boundElements: [...(t.boundElements || []), ref] };
		outById.set(targetId, next);
		changed = true;
	};
	for (const el of out) {
		if (el.isDeleted) continue;
		if (el.type === "arrow") {
			if (el.startBinding?.elementId) addRef(el.startBinding.elementId, { id: el.id, type: "arrow" });
			if (el.endBinding?.elementId) addRef(el.endBinding.elementId, { id: el.id, type: "arrow" });
		}
		if (el.type === "text" && el.containerId) addRef(el.containerId, { id: el.id, type: "text" });
	}
	return { elements: out.map((e) => outById.get(e.id)), changed };
}

/**
 * Keep bound labels positioned inside their containers. Must run after
 * restoreElements({refreshDimensions}) so it uses the re-measured text size.
 */
export function recenterLabels(elements) {
	const PAD = 5;
	const byId = new Map(elements.map((e) => [e.id, e]));
	let changed = false;
	const out = elements.map((el) => {
		if (el.isDeleted || el.type !== "text" || !el.containerId) return el;
		const c = byId.get(el.containerId);
		if (!c || !SHAPE_TYPES.has(c.type) || !hasBox(c) || !hasBox(el)) return el;
		// non-rectangles use inner-box offsets for non-centred text; leave those to Excalidraw
		if (c.type !== "rectangle" && (el.textAlign !== "center" || el.verticalAlign !== "middle")) return el;
		const x =
			el.textAlign === "left"
				? c.x + PAD
				: el.textAlign === "right"
					? c.x + c.width - el.width - PAD
					: c.x + (c.width - el.width) / 2;
		const y =
			el.verticalAlign === "top"
				? c.y + PAD
				: el.verticalAlign === "bottom"
					? c.y + c.height - el.height - PAD
					: c.y + (c.height - el.height) / 2;
		if (Math.abs(x - el.x) <= 1 && Math.abs(y - el.y) <= 1) return el;
		changed = true;
		return { ...el, x, y };
	});
	return { elements: out, changed };
}

/** Same element ids with the same content (bookkeeping fields ignored). */
export function sameContent(a, b) {
	if (a.length !== b.length) return false;
	const keys = new Map(a.map((e) => [e.id, contentKey(e)]));
	return b.every((e) => keys.get(e.id) === contentKey(e));
}

const VOLATILE = new Set(["version", "versionNonce", "updated", "index", "seed"]);

/**
 * Content identity of an element, ignoring bookkeeping fields and sub-pixel
 * drift from text re-measurement.
 */
export function contentKey(el) {
	return JSON.stringify(el, (k, v) => (VOLATILE.has(k) ? undefined : typeof v === "number" ? Math.round(v) : v));
}

export function sceneSig(elements) {
	let sum = 0;
	for (const e of elements) sum += e.version;
	return `${elements.length}:${sum}`;
}

/**
 * Three-way merge between the last synced baseline, the incoming remote
 * elements and the local scene. Remote wins on conflicting edits of the same
 * element; purely local edits made since the baseline are preserved.
 *
 * baseline: Map<id, {version, key}>  (local version + content key at last sync)
 */
export function threeWayMerge(baseline, remote, local) {
	const localById = new Map(local.map((e) => [e.id, e]));
	const remoteIds = new Set(remote.map((e) => e.id));
	let keptLocal = 0;
	const out = [];
	for (const r of remote) {
		const l = localById.get(r.id);
		const base = baseline.get(r.id);
		const remoteChanged = !base || base.key !== contentKey(r);
		const localChanged = l && base && l.version > base.version;
		if (l && localChanged && !remoteChanged) {
			out.push(l);
			keptLocal++;
		} else if ((!l || l.isDeleted) && base && !remoteChanged) {
			// deleted locally, untouched remotely
			if (l) out.push(l);
			keptLocal++;
		} else {
			out.push(r);
		}
	}
	for (const l of local) {
		if (remoteIds.has(l.id) || l.isDeleted) continue;
		const base = baseline.get(l.id);
		if (!base || l.version > base.version) {
			out.push(l); // new locally, or edited locally while deleted remotely
			keptLocal++;
		}
	}
	return { elements: out, keptLocal };
}
