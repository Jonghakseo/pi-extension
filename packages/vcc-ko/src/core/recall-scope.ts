export type RecallScope = "lineage" | "all";
export type RecallMode = "hybrid" | "touched";
/** Rendered roles recall can filter on (see render-entries.ts). */
export type RecallRole = "user" | "assistant" | "tool_result" | "bash" | "custom";

const SCOPE_RE = /\bscope:(lineage|all)\b/i;
const ROLE_RE = /\brole:(user|assistant|tool_result|bash|custom)\b/i;

const VALID_MODES = new Set(["hybrid", "touched"]);
const VALID_ROLES = new Set<RecallRole>(["user", "assistant", "tool_result", "bash", "custom"]);

export const normalizeRecallScope = (scope?: unknown): RecallScope =>
	typeof scope === "string" && scope.toLowerCase() === "all" ? "all" : "lineage";

/**
 * Normalize a mode param to a supported recall mode. Without OM integration,
 * only "touched" adds behavior beyond the default hybrid search — "file"-only
 * search is not implemented in pi-vcc, so it is not exposed.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export const normalizeRecallMode = (mode?: unknown): RecallMode =>
	typeof mode === "string" && VALID_MODES.has(mode.toLowerCase()) ? (mode.toLowerCase() as RecallMode) : "hybrid";

export const parseRecallScope = (text: string): { scope: RecallScope; text: string } => {
	const match = text.match(SCOPE_RE);
	return {
		scope: normalizeRecallScope(match?.[1]),
		text: text.replace(SCOPE_RE, "").replace(/\s+/g, " ").trim(),
	};
};

/**
 * Normalize a role param. Unlike scope and mode there is no default role:
 * undefined means "every role", so an unrecognized value must not silently
 * become a filter that hides most of the session.
 */
export const normalizeRecallRole = (role?: unknown): RecallRole | undefined => {
	if (typeof role !== "string") return undefined;
	const lower = role.toLowerCase() as RecallRole;
	return VALID_ROLES.has(lower) ? lower : undefined;
};

/** Strip a `role:<role>` token from command text, mirroring parseRecallScope. */
export const parseRecallRole = (text: string): { role?: RecallRole; text: string } => {
	const match = text.match(ROLE_RE);
	return {
		role: normalizeRecallRole(match?.[1]),
		text: text.replace(ROLE_RE, "").replace(/\s+/g, " ").trim(),
	};
};
