export const DEFAULT_POLL_COOLDOWN_MS = 10_000;

export interface PollGuardOptions {
	now?: () => number;
	cooldownMs?: number;
}

export type PollGuardDecision = { allowed: true } | { allowed: false; retryInMs: number };

/**
 * Rejects read-only queries whose answer the caller already received within the cooldown window.
 * Signatures are kept per key so alternating queries cannot take turns evading the limit, and
 * entries older than the cooldown are dropped, which bounds the map without extra bookkeeping.
 */
export class PollGuard {
	private readonly entries = new Map<string, Map<string, number>>();
	private readonly now: () => number;
	private readonly cooldownMs: number;

	constructor(options: PollGuardOptions = {}) {
		const configured = options.cooldownMs ?? Number(process.env.PI_BASH_ASYNC_POLL_COOLDOWN_MS);
		this.cooldownMs =
			Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_POLL_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
	}

	check(key: string, signature: string): PollGuardDecision {
		const now = this.now();
		this.prune(now);
		const seen = this.entries.get(key) ?? new Map<string, number>();
		const previous = seen.get(signature);
		if (previous !== undefined) {
			const elapsed = now - previous;
			if (elapsed < this.cooldownMs) return { allowed: false, retryInMs: this.cooldownMs - elapsed };
		}
		seen.set(signature, now);
		this.entries.set(key, seen);
		return { allowed: true };
	}

	forget(key: string): void {
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
	}

	/** Number of tracked signatures, used to assert that pruning keeps the guard bounded. */
	entryCount(): number {
		let total = 0;
		for (const seen of this.entries.values()) total += seen.size;
		return total;
	}

	private prune(now: number): void {
		for (const [key, seen] of this.entries) {
			for (const [signature, at] of seen) {
				if (now - at >= this.cooldownMs) seen.delete(signature);
			}
			if (seen.size === 0) this.entries.delete(key);
		}
	}
}
