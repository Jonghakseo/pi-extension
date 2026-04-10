import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
		environment: "node",
		clearMocks: true,
		restoreMocks: true,
		mockReset: true,
		coverage: {
			provider: "v8",
			reportsDirectory: "coverage",
			reporter: ["text", "html"],
			include: [
				"packages/auto-name/utils/**/*.ts",
				"packages/clipboard/index.ts",
				"packages/codex-fast-mode/index.ts",
				"packages/generative-ui/guidelines.ts",
				"packages/generative-ui/html-utils.ts",
				"packages/generative-ui/svg-styles.ts",
			],
			exclude: ["packages/**/*.test.ts"],
			thresholds: {
				100: true,
				perFile: true,
			},
		},
	},
});
