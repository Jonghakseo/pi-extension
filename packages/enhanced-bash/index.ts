import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBackgroundRuntime } from "./background/runtime.js";
import { registerBashTool } from "./bash-tool.js";

export default function enhancedBash(pi: ExtensionAPI): void {
	const background = registerBackgroundRuntime(pi);
	registerBashTool(pi, background);
}
