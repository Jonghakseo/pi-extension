import type { BashToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderResultText } from "./background/render.js";
import type { BackgroundRuntime } from "./background/runtime.js";
import {
	DEFAULT_TIMEOUT_SECONDS as BACKGROUND_DEFAULT_TIMEOUT_SECONDS,
	formatSyncWindow,
} from "./background/tool-schema.js";
import {
	abbreviateLeadingCwd,
	BashCallPreview,
	clearRunningRenderTimer,
	deriveTitle,
	formatRunningDuration,
	getBashTextContent,
	type RunningRenderState,
	renderError,
	renderExpandedOutput,
	reuseText,
} from "./bash-ui.js";
import { MAX_TIMER_SECONDS, runForeground } from "./foreground.js";
import { platformGuidance, resolveShellOptions } from "./platform.js";

export const FOREGROUND_DEFAULT_TIMEOUT_SECONDS = 300;

export interface EnhancedBashParams {
	command: string;
	title: string;
	timeout?: number;
	runInBackground?: boolean;
}

function description(syncWindowMs: number): string {
	const platform = platformGuidance(resolveShellOptions(process.cwd()));
	const wait =
		syncWindowMs > 0
			? ` A background start waits up to ${formatSyncWindow(syncWindowMs)} and returns the result inline if the command finishes by then.`
			: "";
	return `Execute a bash command in the current working directory.

Title is a short one-sentence summary of what the command does, shown in the UI. Write the title in the language the user is using.

A foreground command that is still running when its timeout (default ${FOREGROUND_DEFAULT_TIMEOUT_SECONDS}s) ends is not killed: it moves to the background and keeps running for up to ${BACKGROUND_DEFAULT_TIMEOUT_SECONDS}s more.

Set runInBackground to true for finite, non-interactive commands when the next action does not need the result immediately.${wait} Background results arrive automatically; do not sleep or poll to wait. Stop a background job with bash_stop. TUI, REPL, and commands requiring stdin are unsupported.${platform ? `\n\n${platform}` : ""}`;
}

export const bashParameters = Type.Object({
	command: Type.String({ description: "The bash command to execute" }),
	title: Type.String({
		description: "A short one-sentence summary of what the command does, written in the user's language.",
	}),
	timeout: Type.Optional(
		Type.Number({
			description: `Seconds to wait in the foreground before the command moves to the background (default ${FOREGROUND_DEFAULT_TIMEOUT_SECONDS}), or with runInBackground the seconds the job may run (default ${BACKGROUND_DEFAULT_TIMEOUT_SECONDS}). 0 removes the limit.`,
		}),
	),
	runInBackground: Type.Optional(
		Type.Boolean({
			description:
				"Run as a background job whose result is reported automatically when it finishes. Defaults to false.",
		}),
	),
});

/** Fills a missing title so the UI header and background job list always have something to show. */
export function prepareBashArguments(args: unknown): EnhancedBashParams {
	if (!args || typeof args !== "object") return args as never;
	const a = args as Record<string, unknown>;
	const command = typeof a.command === "string" ? a.command : "";
	const title = typeof a.title === "string" && a.title.length > 0 ? a.title : deriveTitle(command);
	// Both the foreground wait and a background job's limit end up in a timer, so neither may exceed its range.
	const timeout =
		typeof a.timeout === "number" && Number.isFinite(a.timeout) && a.timeout >= 0
			? Math.min(a.timeout, MAX_TIMER_SECONDS)
			: undefined;
	const runInBackground = a.runInBackground === true;
	return { command, title, timeout, runInBackground };
}

export function registerBashTool(pi: ExtensionAPI, background: BackgroundRuntime): void {
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: description(background.syncWindowMs),
		parameters: bashParameters,
		promptSnippet: "Execute commands in a bash shell; use title to describe the command's purpose",
		promptGuidelines: [
			"Always provide a concise title for bash commands describing what the command accomplishes, written in the language the user is using.",
			"Use bash with runInBackground: true for long finite commands whose result is not needed immediately. Background results arrive automatically, so do not sleep or poll; stop a job with bash_stop.",
		],
		prepareArguments: prepareBashArguments,
		renderCall(args, theme, context) {
			const params = args as Partial<EnhancedBashParams>;
			const command = typeof params.command === "string" ? params.command : "";
			const previewCommand = context.expanded ? command : abbreviateLeadingCwd(command, context.cwd);
			const label = params.runInBackground ? "bash &" : "bash";
			const header =
				typeof params.title === "string" && params.title.length > 0
					? `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", params.title)}`
					: theme.fg("toolTitle", theme.bold(label));
			return new BashCallPreview(header, previewCommand, theme);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const runningState = context.state as RunningRenderState;
			const args = context.args as Partial<EnhancedBashParams> | undefined;
			const details = result.details as { jobId?: unknown } | undefined;
			if (args?.runInBackground || typeof details?.jobId === "string") {
				clearRunningRenderTimer(runningState);
				const text = renderResultText(result, expanded);
				return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
			}
			if (isPartial) {
				runningState.bashStartedAt ??= Date.now();
				if (!runningState.bashTimer) {
					runningState.bashTimer = setInterval(() => context.invalidate(), 1000);
					runningState.bashTimer.unref?.();
				}
				return reuseText(
					context,
					theme.fg("warning", `~${formatRunningDuration(Date.now() - runningState.bashStartedAt)}`),
				);
			}

			clearRunningRenderTimer(runningState);
			const renderedText = getBashTextContent(result as { content?: Array<{ type: string; text?: string }> });
			if (context.isError) return renderError(context, expanded, renderedText, theme);
			if (!expanded) return reuseText(context, "");
			return renderExpandedOutput(context, renderedText, result.details as BashToolDetails | undefined, theme);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { command, title, timeout, runInBackground } = params as EnhancedBashParams;
			if (runInBackground) return background.start({ command, title, timeout }, ctx, signal);
			return runForeground({
				toolCallId,
				command,
				title,
				waitSeconds: timeout ?? FOREGROUND_DEFAULT_TIMEOUT_SECONDS,
				backgroundTimeoutSeconds: BACKGROUND_DEFAULT_TIMEOUT_SECONDS,
				context: ctx,
				signal,
				onUpdate,
				adopt: (moved) => background.adopt({ ...moved, timeoutSeconds: BACKGROUND_DEFAULT_TIMEOUT_SECONDS }, ctx),
			});
		},
	});
}
