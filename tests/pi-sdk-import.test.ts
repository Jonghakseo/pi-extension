import { describe, expect, it } from "vitest";

describe("Pi SDK runtime package", () => {
	it("loads the public entrypoint without undeclared runtime dependencies", async () => {
		// Keep this import real: mocks and typechecking miss packaging regressions such as Pi #9170.
		const sdk = await import("@earendil-works/pi-coding-agent");

		expect(sdk.discoverAndLoadExtensions).toBeTypeOf("function");
		expect(sdk.createExtensionRuntime).toBeTypeOf("function");
		expect(sdk.CustomEditor).toBeTypeOf("function");
	});
});
