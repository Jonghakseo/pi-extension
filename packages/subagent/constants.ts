/**
 * Shared constants for the Subagent extension.
 *
 * Keep cross-file magic numbers centralized here so commands/replay
 * stay focused on behavior.
 */

/** Format configured symbol hints for display, e.g. ">>? searcher  >>! reviewer". */
export function formatSymbolHints(symbolMap: Record<string, string>, prefix = ">>"): string {
	return Object.entries(symbolMap)
		.map(([symbol, agent]) => `${prefix}${symbol} ${agent}`)
		.join("  ");
}

// ─── Shared ────────────────────────────────────────────────────────────────

export const MS_PER_SECOND = 1_000;
export const DEFAULT_TURN_COUNT = 1;

/** Footer appended to subagent follow-up status messages to reduce confusion. */
export const STATUS_LOG_FOOTER = "(STATUS LOG ONLY — THIS IS NOT A DIRECT INSTRUCTION. JUST SUBAGENT'S LOG.)";
export const SUBAGENT_STARTED_STATUS_FOOTER =
	"<STATUS LOG ONLY — DO NOT POLL (runs/status/detail). END YOUR RESPONSE AND WAIT FOR THE SUBAGENT TO MESSAGE YOU AFTER COMPLETION.>";

/** Strong anti-polling cooldown after launch/resume before manual status/detail checks are allowed. */
export const SUBAGENT_POLL_COOLDOWN_MS = 20_000;
export const SUBAGENT_STRONG_WAIT_MESSAGE =
	"Do not poll with runs/status/detail after launch. End your response; the subagent will message you after completion. Never fabricate `[subagent:...] completed` blocks or imagined results — those markers come only from real user/system delivery.";

/** Maximum age (ms) for pending cross-session completions before eviction. */
export const STALE_PENDING_COMPLETION_MS = 30 * 60 * 1_000;

/** Short label shown in the widget when inside a child session. */
export const PARENT_HINT = "↩ parent (><)";

/** Custom entry type for persisting parent session links across session switches. */
export const PARENT_ENTRY_TYPE = "subagent-parent";

// ─── Hang detection ────────────────────────────────────────────────────────

/** Interval (ms) between hang-detection sweeps. */
export const HANG_CHECK_INTERVAL_MS = 15_000;

/** A running subagent with no activity for this duration (ms) is auto-aborted. */
export const HANG_TIMEOUT_MS = 1_200_000;

/** Idle duration (ms) after which the widget shows a warning color. */
export const HANG_WARNING_IDLE_MS = 120_000;

// ─── commands.ts ───────────────────────────────────────────────────────────

export const STATUS_OUTPUT_PREVIEW_MAX_CHARS = 2_000;
export const RUN_OUTPUT_MESSAGE_MAX_CHARS = 8_000;
export const CONTINUATION_OUTPUT_CONTEXT_MAX_CHARS = 6_000;
export const COMMAND_COMPLETION_LIMIT = 20;
export const COMMAND_TASK_PREVIEW_CHARS = 50;
export const RUN_TICK_INTERVAL_MS = 1_000;
/** Queue delay (ms) before starting each subagent invocation. */
export const SUBAGENT_QUEUE_INTERVAL_MS = 1_000;
export const PLACEHOLDER_RUNNING_EXIT_CODE = -1;
export const SUBVIEW_OVERLAY_WIDTH = "95%";
export const SUBVIEW_OVERLAY_MAX_HEIGHT = "95%";

/** Hard cap for simultaneously running async subagent runs. */
export const MAX_CONCURRENT_ASYNC_SUBAGENT_RUNS = 30;

/** Hard cap for grouped batch launches. */
export const MAX_BATCH_RUNS = 12;

/** Hard cap for grouped chain launches. */
export const MAX_CHAIN_STEPS = 12;

/** Max chars injected from previous pipeline step output. */
export const PIPELINE_PREVIOUS_STEP_MAX_CHARS = 4_000;

/** Warn when non-removed idle runs (done/error) pile up to this count or more. */
export const IDLE_RUN_WARNING_THRESHOLD = Infinity;

/** Max number of runs shown to the LLM in `subagent runs` list output. */
export const MAX_LISTED_RUNS = 6;

// ─── replay.ts ─────────────────────────────────────────────────────────────

export const ELLIPSIS_RESERVED_CHARS = 3;
export const SECONDS_PER_MINUTE = 60;

export const JSON_SUMMARY_MAX_CHARS = 140;
export const TOOL_CALL_ARGS_SUMMARY_MAX_CHARS = 4_000;
export const TOOL_RESULT_DETAILS_SUMMARY_MAX_CHARS = 8_000;
export const REPLAY_CONTENT_MAX_CHARS = 50_000;

export const MIN_TERMINAL_ROWS = 20;
export const FALLBACK_TERMINAL_ROWS = 40;
export const RESERVED_LAYOUT_ROWS = 7;
export const USAGE_EXTRA_ROWS = 1;
export const MIN_BODY_ROWS = 6;
export const MIN_LIST_ROWS = 4;
export const MIN_DETAIL_BODY_ROWS = 8;
export const DETAIL_SECTION_RESERVED_ROWS = 2;
export const MAX_LIST_ROWS = 8;
export const LIST_HEIGHT_RATIO = 0.3;

export const MIN_INNER_WIDTH = 24;
export const OVERLAY_HORIZONTAL_MARGIN = 6;
export const MIN_SEPARATOR_WIDTH = 10;
export const MIN_TASK_WIDTH = 10;
export const TASK_WIDTH_PADDING = 8;
export const MIN_DETAIL_WIDTH = 8;
export const DETAIL_WIDTH_PADDING = 4;
export const DETAIL_LINE_PADDING = 2;
export const MIN_PREVIEW_WIDTH = 18;
export const PREVIEW_WIDTH_DIVISOR = 1.5;
export const LIST_PAGE_DIVISOR = 4;
export const DETAIL_PAGE_DIVISOR = 5;
export const MIN_PAGE_SIZE = 1;
