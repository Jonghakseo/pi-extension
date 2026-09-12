export type ProcessLiveness = "alive" | "dead" | "unknown";
export function processStartIdentity(pid: number): string | undefined;
export function ownProcessStartIdentity(): string | undefined;
export function processLiveness(pid: number, expectedIdentity?: string): ProcessLiveness;
