export type CronJobKind = "cron" | "at" | "delay";

export type CronDisabledReason = "completed_once" | "user_disabled" | "error";

export interface CronJob {
	id: string;
	name: string;
	enabled: boolean;
	kind: CronJobKind;
	once: boolean;
	schedule?: string;
	runAt?: string;
	timezone: string;
	cwd: string;
	promptFile: string;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	running?: boolean;
	lastExitCode?: number;
	disabledReason?: CronDisabledReason;
	completedAt?: string;
	lastRunLog?: string;
}

export interface CronStoreFile {
	version: 1;
	jobs: CronJob[];
}

export interface DaemonStatus {
	running: boolean;
	pid?: number;
	stalePid?: number;
}

export interface LaunchdStatus {
	installed: boolean;
	loaded: boolean;
	plistPath: string;
	label: string;
}
