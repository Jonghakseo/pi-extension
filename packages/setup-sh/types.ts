export type SetupStatus = "running" | "success" | "failed" | "cancelled" | "stale";
export type DisplayStatus = SetupStatus | "pending" | "skipped";
export type StartMode = "auto" | "manual" | "rerun";

export type SetupContext = {
	repoRoot: string;
	setupPath: string;
	repoKey: string;
	setupHash: string;
	paths: StatePaths;
};

export type StatePaths = {
	rootDir: string;
	locksDir: string;
	logsDir: string;
	statesDir: string;
	exitsDir: string;
	wrappersDir: string;
	lockPath: string;
	statePath: string;
};

export type LockRecord = {
	repoKey: string;
	repoRoot: string;
	setupPath: string;
	setupHash: string;
	runId: string;
	pid: number;
	coordinatorPid: number;
	startedAt: string;
	logPath: string;
	exitPath: string;
	lockPath: string;
};

export type RunRecord = LockRecord & {
	status: SetupStatus;
	mode: StartMode;
	finishedAt?: string;
	exitCode?: number;
	message?: string;
};

export type ExitRecord = {
	status: SetupStatus;
	exitCode: number;
	finishedAt: string;
};

export type StartResult =
	| { kind: "started"; context: SetupContext; record: RunRecord }
	| { kind: "running"; context: SetupContext; record: RunRecord; owner: "self" | "other" }
	| { kind: "skipped"; context: SetupContext; record?: RunRecord; reason: string }
	| { kind: "no-setup"; reason: string }
	| { kind: "failed"; context?: SetupContext; reason: string };

export type Snapshot = {
	visible: boolean;
	status: DisplayStatus;
	repoRoot: string;
	owner: "self" | "other" | "none";
	startedAt?: string;
	finishedAt?: string;
	exitCode?: number;
	message?: string;
	logPath?: string;
};
