import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { BashAsyncJob } from "./types.js";

const MAX_TITLE_WIDTH = 80;
const WIDGET_LABEL = "bash_async";
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI control sequences from user-provided titles.
const ANSI_ESCAPE_SEQUENCE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export interface RunningJobsWidgetOptions {
	getRunningJobs: () => readonly BashAsyncJob[];
	now?: () => number;
}

export function sanitizeTitle(title: string): string {
	return [...title.replace(ANSI_ESCAPE_SEQUENCE, "")]
		.map((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

export function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export class RunningJobsWidget implements Component {
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly theme: Pick<Theme, "fg">,
		private readonly options: RunningJobsWidgetOptions,
	) {
		this.timer = setInterval(() => this.tui.requestRender(), 1_000);
		this.timer.unref?.();
	}

	render(width: number): string[] {
		const now = (this.options.now ?? Date.now)();
		return this.options
			.getRunningJobs()
			.filter((job) => job.status === "running")
			.slice()
			.sort((left, right) => (left.startedAt ?? left.queuedAt) - (right.startedAt ?? right.queuedAt))
			.map((job) => this.renderJob(job, now, width));
	}

	invalidate(): void {}

	refresh(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private renderJob(job: BashAsyncJob, now: number, width: number): string {
		const elapsed = formatElapsed(now - (job.startedAt ?? job.queuedAt));
		const prefix = `${WIDGET_LABEL} · `;
		const suffix = ` · ${elapsed}`;
		const availableTitleWidth = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));
		const title = truncateToWidth(
			sanitizeTitle(job.title) || "bash job",
			Math.min(MAX_TITLE_WIDTH, availableTitleWidth),
			"...",
		);
		const line =
			this.theme.fg("accent", WIDGET_LABEL) +
			this.theme.fg("muted", " · ") +
			this.theme.fg("text", title) +
			this.theme.fg("muted", suffix);
		return truncateToWidth(line, width, this.theme.fg("muted", "..."));
	}
}

export function createRunningJobsWidget(
	tui: Pick<TUI, "requestRender">,
	theme: Pick<Theme, "fg">,
	options: RunningJobsWidgetOptions,
): RunningJobsWidget {
	return new RunningJobsWidget(tui, theme, options);
}
