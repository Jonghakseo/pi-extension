import {
	type BashToolDetails,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type Theme,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

const TAIL_LINES = 5;
const MAX_COMMAND_PREVIEW = 120;
const MIN_COMMAND_PREVIEW_WIDTH = 16;

type BashContent = { type: "text"; text: string };

export function getBashTextContent(result: { content?: Array<{ type: string; text?: string }> }): string | undefined {
	const textContent = result.content?.find(
		(entry): entry is BashContent => entry.type === "text" && typeof entry.text === "string",
	);
	return textContent?.text;
}

function normalizeInlinePreview(value: string): string {
	return value.replace(/\r\n|\r|\n/g, " ");
}

const LEADING_CD_PATTERN = /^cd\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s;&|()]+))/;

export function abbreviateLeadingCwd(command: string, cwd: string): string {
	if (!cwd) return command;

	const match = command.match(LEADING_CD_PATTERN);
	if (!match) return command;

	const [matched, singleQuoted, doubleQuoted, bare] = match;
	let target: string;
	if (singleQuoted !== undefined) target = singleQuoted;
	else if (doubleQuoted !== undefined) target = doubleQuoted.replace(/\\(["\\$`])/g, "$1");
	else target = bare;

	if (target !== cwd && !target.startsWith(`${cwd}/`)) return command;

	const remainder = command.slice(matched.length);
	if (remainder.length > 0 && !/^[\s;&|)]/.test(remainder)) return command;

	return `cd <cwd>${target.slice(cwd.length)}${remainder}`;
}

export class BashCallPreview implements Component {
	private readonly text = new Text("", 0, 0);

	constructor(
		private readonly header: string,
		private readonly command: string,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const header = truncateToWidth(this.header, width, this.theme.fg("accent", "..."));
		const commandPreview = this.formatCommandPreview(width);
		this.text.setText(commandPreview ? `${header}\n${this.theme.fg("dim", commandPreview)}` : header);
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	private formatCommandPreview(width: number): string {
		if (!this.command || width < MIN_COMMAND_PREVIEW_WIDTH) return "";
		return truncateToWidth(normalizeInlinePreview(`$ ${this.command}`), Math.min(width, MAX_COMMAND_PREVIEW), "...");
	}
}

export function formatRunningDuration(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export type RunningRenderState = {
	bashStartedAt?: number;
	bashTimer?: ReturnType<typeof setInterval>;
};

export function clearRunningRenderTimer(state: RunningRenderState): void {
	if (state.bashTimer) {
		clearInterval(state.bashTimer);
		state.bashTimer = undefined;
	}
	state.bashStartedAt = undefined;
}

function formatTruncationWarning(
	details: BashToolDetails | undefined,
	theme: { fg: (color: "warning", text: string) => string },
): string {
	const truncation = details?.truncation;
	if (!truncation?.truncated) return "";

	if (truncation.firstLineExceedsLimit) {
		return `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
	}

	if (truncation.truncatedBy === "lines") {
		return `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
	}

	return `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
}

/**
 * Derive a short title from a bash command when the LLM doesn't provide one.
 * Takes the first command word and key flags/args.
 */
export function deriveTitle(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return "bash";

	// Strip leading env vars (KEY=val ...) and common prefixes
	const withoutEnv = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s*/, "");
	const withoutSudo = withoutEnv.replace(/^sudo\s+/, "");

	// Extract the first word (the command)
	const match = withoutSudo.match(/^\S+/);
	if (!match) return "bash";
	return match[0];
}

export function reuseText(context: { lastComponent?: Component }, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

export function renderError(
	context: { lastComponent?: Component; isError: boolean },
	expanded: boolean,
	renderedText: string | undefined,
	theme: Theme,
): Text {
	if (!expanded) {
		return reuseText(context, theme.fg("error", "✗ Error"));
	}
	return reuseText(context, theme.fg("error", renderedText ?? "Command failed."));
}

export function renderExpandedOutput(
	context: { lastComponent?: Component },
	renderedText: string | undefined,
	details: BashToolDetails | undefined,
	theme: Theme,
): Text {
	if (!renderedText) {
		return reuseText(context, "");
	}

	const contextTruncation = truncateTail(renderedText, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const allLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];
	const tailLines = allLines.slice(-TAIL_LINES);
	const hiddenCount = allLines.length - tailLines.length;

	const body = tailLines.map((line: string) => theme.fg("muted", line)).join("\n");
	const truncationWarning = formatTruncationWarning(details, theme);

	const statusParts: string[] = [];
	if (hiddenCount > 0) {
		statusParts.push(theme.fg("dim", `... ${hiddenCount} more lines above`));
	}
	if (truncationWarning) {
		statusParts.push(truncationWarning.trim());
	}

	let outputText = body;
	if (statusParts.length > 0) {
		outputText += `\n${statusParts.join("\n")}`;
	}

	return reuseText(context, outputText);
}
