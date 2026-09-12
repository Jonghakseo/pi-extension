export const DAEMON_PROTOCOL_VERSION: number;

export interface DaemonRuntimeOwner {
	pid: number;
	processIdentity: string;
	runtimeId: string;
	protocolVersion: number;
	daemonPath: string;
	drainTimeoutMs?: number;
}

export function getDaemonPath(): string;
export function daemonRuntimeId(daemonPath?: string): string;
export function daemonOwnerPath(cronDir: string): string;
export function readDaemonOwner(cronDir: string): DaemonRuntimeOwner | undefined;
export function daemonOwnerLiveness(owner: DaemonRuntimeOwner | undefined): "alive" | "dead" | "unknown";
export function writeDaemonOwner(
	cronDir: string,
	daemonPath?: string,
	options?: { drainTimeoutMs?: number },
): DaemonRuntimeOwner;
export function removeDaemonOwner(cronDir: string, expectedPid?: number, expectedIdentity?: string): void;
export function daemonOwnerExists(cronDir: string): boolean;
