/** Shared mutable state for the web-access extension. Kept dependency-free. */
export const state = {
	pendingFetches: new Map<string, AbortController>(),
	sessionActive: false,
	widgetVisible: false,
	widgetUnsubscribe: null as (() => void) | null,
};
