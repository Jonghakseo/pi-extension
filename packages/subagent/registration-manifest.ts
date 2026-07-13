export const SUBAGENT_COMMANDS = {
	"sub:isolate":
		"Run a subagent in a dedicated sub-session: /sub:isolate <agent|alias> <task>, /sub:isolate <runId> <task>, /sub:isolate <task> (uses configured defaultAgent)",
	"sub:main": "Run a subagent with main-session context inheritance: /sub:main <agent|alias> <task>",
	subagents: "List available subagents and offer the starter pack when none are configured",
	"sub:peek": "Show the latest response from a subagent in an overlay: /sub:peek [runId]",
	"sub:open": "Open a subagent session replay overlay: /sub:open [runId]",
	"sub:history": "Show all subagent run history (including removed) in an overlay: /sub:history",
	"sub:rm": "Remove one /sub job entry (aborts it if running): /sub:rm [runId]",
	"sub:clear": "Clear /sub job widget entries. /sub:clear (finished only) or /sub:clear all",
	"sub:abort": "Abort running subagent job(s). /sub:abort [runId|all]",
} as const;

export type SubagentCommandName = keyof typeof SUBAGENT_COMMANDS;

export const SUBAGENT_SHORTCUTS = {
	">>": "Run subagent task",
	"#<runId>": "Resume subagent run: #<runId> <task>",
	"<<": "Abort or clear subagent runs",
	"<<<": "Clear finished subagent jobs (= /sub:clear). <<< all to clear all",
} as const;

export type SubagentShortcutName = keyof typeof SUBAGENT_SHORTCUTS;
