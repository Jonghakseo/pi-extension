import { describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => [] as unknown[]);
vi.mock("./storage.js", () => ({ getAllResults: () => stored, deleteResult: vi.fn() }));

import { registerCommands } from "./commands.js";

describe("/search", () => {
	it("lists URLs and lengths for a restored reference-style fetch result", async () => {
		stored.push({
			id: "abc123def",
			type: "fetch",
			timestamp: Date.now(),
			urlMetadata: [
				{ url: "https://example.com/a", title: "A", error: null, contentLength: 1234 },
				{ url: "https://example.com/b", title: "", error: "HTTP 404", contentLength: 0 },
			],
		});
		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		registerCommands({
			registerCommand: (_name: string, def: { handler: typeof handler }) => {
				handler = def.handler;
			},
		} as never);

		const notify = vi.fn();
		const select = vi.fn(async (_title: string, options: string[]) => options[0]);
		await handler?.("", { ui: { select, notify } });

		const info = notify.mock.calls[0]?.[0] as string;
		expect(info).toContain("- https://example.com/a (1234 chars)");
		expect(info).toContain("- https://example.com/b (HTTP 404)");
	});
});
