/**
 * Module names for guideline sections, kept separate from guidelines.ts so the
 * boot path can build the tool schema without loading the large guideline text.
 * Keys must match MODULE_SECTIONS in guidelines.ts (verified in helpers.test.ts).
 */
export const AVAILABLE_MODULES = ["art", "mockup", "interactive", "chart", "diagram"];
