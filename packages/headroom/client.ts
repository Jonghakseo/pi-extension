import type { CompressResult, OpenAIMessage } from "./types.ts";

interface ProxyCompressResponse {
	messages: OpenAIMessage[];
	tokens_before: number;
	tokens_after: number;
	tokens_saved: number;
	compression_ratio: number;
	transforms_applied: string[];
	ccr_hashes?: string[];
}

interface HeadroomClientOptions {
	baseUrl: string;
	timeoutMs: number;
}

export class HeadroomHttpClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(options: HeadroomClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.timeoutMs = options.timeoutMs;
	}

	async health(signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/health`, {
				signal: buildSignal(this.timeoutMs, signal),
			});
			if (!response.ok) return false;
			const body = await readJsonObject(response);
			if (!body) return true;
			return body.status === "healthy" || body.status === "ok" || "optimize" in body || "stats" in body;
		} catch {
			return false;
		}
	}

	async stats(signal?: AbortSignal): Promise<unknown> {
		const response = await fetch(`${this.baseUrl}/stats`, {
			signal: buildSignal(this.timeoutMs, signal),
		});
		if (!response.ok) {
			throw new Error(`Headroom /stats failed with HTTP ${response.status}`);
		}
		return response.json();
	}

	async compress(messages: OpenAIMessage[], model: string | undefined, signal?: AbortSignal): Promise<CompressResult> {
		const response = await fetch(`${this.baseUrl}/v1/compress`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Headroom-Stack": "pi-extension",
			},
			body: JSON.stringify({ messages, model: model || "gpt-4o" }),
			signal: buildSignal(this.timeoutMs, signal),
		});

		if (!response.ok) {
			const message = await readErrorMessage(response);
			throw new Error(message || `Headroom /v1/compress failed with HTTP ${response.status}`);
		}

		const payload = (await response.json()) as ProxyCompressResponse;
		return {
			messages: payload.messages,
			tokensBefore: payload.tokens_before,
			tokensAfter: payload.tokens_after,
			tokensSaved: payload.tokens_saved,
			compressionRatio: payload.compression_ratio,
			transformsApplied: payload.transforms_applied ?? [],
			ccrHashes: payload.ccr_hashes ?? [],
			compressed: true,
		};
	}
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
	try {
		const body = (await response.json()) as unknown;
		return isRecord(body) ? body : undefined;
	} catch {
		return undefined;
	}
}

async function readErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as unknown;
		if (!isRecord(body)) return undefined;
		const error = body.error;
		if (isRecord(error) && typeof error.message === "string") return error.message;
		if (typeof body.message === "string") return body.message;
	} catch {
		// Ignore malformed error bodies.
	}
	return undefined;
}

function buildSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!signal) return timeoutSignal;
	if (signal.aborted) return signal;
	return AbortSignal.any([signal, timeoutSignal]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
