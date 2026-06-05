import { describe, expect, it } from "vitest";
import { createExtensionApiMock } from "../../tests/mock-extension-api.ts";
import { AVAILABLE_MODULES, getGuidelines } from "./guidelines.ts";
import { escapeJS, shellHTML, wrapHTML } from "./html-utils.ts";
import generativeUi, { shouldApplyFinalStreamingHTML } from "./index.ts";

describe("generative-ui helpers", () => {
	it("returns guideline content for requested modules", () => {
		const guidelines = getGuidelines([AVAILABLE_MODULES[0], AVAILABLE_MODULES[1] ?? AVAILABLE_MODULES[0]]);
		expect(guidelines).toContain("Imagine — Visual Creation Suite");
		expect(guidelines.length).toBeGreaterThan(1000);
	});

	it("skips unknown modules and deduplicates repeated guideline sections", () => {
		const diagramOnly = getGuidelines(["diagram", "diagram", "unknown"]);
		expect(diagramOnly.match(/## Diagram types/g)).toHaveLength(1);
		expect(diagramOnly.endsWith("\n")).toBe(true);
	});

	it("builds shell and wrapped html documents", () => {
		expect(shellHTML()).toContain("morphdom");
		expect(wrapHTML("<div>hello</div>")).toContain("<body><div>hello</div>");
		expect(wrapHTML("<svg></svg>", true)).toContain("display:flex");
	});

	it("escapes script-sensitive strings safely", () => {
		expect(escapeJS("a'b\\c\n</script>")).toBe("a\\'b\\\\c\\n<\\/script>");
	});

	it("exposes visualize_read_me modules as a plain enum schema", () => {
		const { api, getTool } = createExtensionApiMock();
		generativeUi(api);

		const tool = getTool("visualize_read_me");
		const parameters = tool.parameters as {
			properties?: { modules?: { items?: { enum?: string[]; anyOf?: unknown } } };
		};
		const items = parameters.properties?.modules?.items;

		expect(items?.enum).toEqual(AVAILABLE_MODULES);
		expect(items?.anyOf).toBeUndefined();
	});

	it("applies final streaming html only once", () => {
		expect(shouldApplyFinalStreamingHTML("<div></div>", false)).toBe(true);
		expect(shouldApplyFinalStreamingHTML("<div></div>", true)).toBe(false);
		expect(shouldApplyFinalStreamingHTML(null, false)).toBe(false);
	});
});
