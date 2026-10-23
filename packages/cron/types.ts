export type CronJobKind = "cron" | "at" | "delay";
export type CronScope = "user" | "project" | "session";

export type CronDisabledReason = "completed_once" | "user_disabled" | "error";
export type SessionDeliveryOutcome = "queued" | "settled" | "aborted" | "failed";
export type CronGuardMode = "exit" | "changed";

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
	/** Legacy jobs without this field are globally managed user jobs. */
	scope?: CronScope;
	/** Present only for project jobs. */
	projectId?: string;
	/** Present only for session jobs. */
	sessionId?: string;
	/** Canonical persisted source session file for session jobs. */
	sessionFile?: string;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	running?: boolean;
	/** Unique token for the currently claimed execution. */
	runToken?: string;
	/** Immutable prompt copy used by the currently claimed execution. */
	runPromptFile?: string;
	/** Immutable prompt copy from the most recently completed execution. */
	lastRunPromptFile?: string;
	lastExitCode?: number;
	disabledReason?: CronDisabledReason;
	completedAt?: string;
	lastRunLog?: string;
	/** Session prompt transport outcome, not task success. */
	lastDeliveryOutcome?: SessionDeliveryOutcome;
	lastDeliveryError?: string;
	/** Shell command run with `/bin/sh -c` before each execution to decide whether the job runs. */
	guard?: string;
	/** `exit` (default): run on exit 0. `changed`: run on exit 0 with non-empty stdout that differs from the last run. */
	guardMode?: CronGuardMode;
	/** Guard timeout in milliseconds. Defaults to 60000. */
	guardTimeoutMs?: number;
	lastGuardAt?: string;
	/** Guard exit code, or "timeout". Absent when the guard could not start or was killed by a signal. */
	lastGuardExit?: number | "timeout";
	/** SHA-256 of trimmed guard stdout from the last successful run in `changed` mode. */
	lastGuardHash?: string;
	lastGuardError?: string;
}

export interface CronStoreFile {
	version: 2;
	jobs: CronJob[];
	history: CronJob[];
}

export interface DaemonStatus {
	running: boolean;
	pid?: number;
	stalePid?: number;
	/** SHA-256 identity of the daemon artifact, when the running daemon supports upgrade coordination. */
	runtimeId?: string;
	/** A pre-upgrade daemon that has only daemon.pid and must use the conservative legacy fence. */
	legacy?: boolean;
	/** Features advertised by the running daemon. Absent on daemons older than capability negotiation. */
	capabilities?: string[];
}

export interface LaunchdStatus {
	installed: boolean;
	loaded: boolean;
	plistPath: string;
	label: string;
}
