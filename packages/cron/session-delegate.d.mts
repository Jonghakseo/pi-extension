export const SESSION_DELEGATE_VERSION: 1;
export const SESSION_DELEGATE_QUERY_CHANNEL: "cron.session-delegate.query";
export const SESSION_DELEGATE_INFO_CHANNEL: "cron.session-delegate.info";

/** What the extension emits on `SESSION_DELEGATE_INFO_CHANNEL` in answer to a query. */
export type SessionDelegateInfo =
	| {
			version: 1;
			available: true;
			/** Absolute path of `session-delegate.mjs` in the installed package. */
			modulePath: string;
			agentDir: string;
			sessionId: string;
			sessionFile: string;
	  }
	| { version: 1; available: false };

export class SessionDelegateBusyError extends Error {
	readonly code: "busy";
	constructor(state: string);
}

export interface DelegatedSessionOwner {
	readonly state: "starting" | "active" | "reserved" | "stopped";
	readonly endpoint: string;
	reserveForSuccessor(): Promise<string>;
	releaseReservation(): "released" | "adopted" | "none";
	stop(): Promise<void>;
}

export function getSessionDelegatePath(): string;
export function delegateOwnerPath(agentDir: string, sessionId: string): string;
export function claimDelegatedSessionOwner(options: {
	agentDir: string;
	sessionId: string;
	sessionFile: string;
	onDeferred?: (delivery: { id: string }) => void;
}): Promise<DelegatedSessionOwner>;
