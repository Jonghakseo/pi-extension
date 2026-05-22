/**
 * Clipboard Extension
 *
 * Provides tools that allow the LLM to copy text to the user's clipboard
 * using OSC52 escape sequences and to paste text from the user's clipboard
 * via OS-native commands (pbpaste / xclip / wl-paste / Get-Clipboard).
 *
 * Usage:
 *   Ask the LLM: "write me a draft reply and put it into clipboard!"
 *   Ask the LLM: "paste my clipboard and summarize it."
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

/**
 * Encode text to base64 for OSC52
 */
function toBase64(text: string): string {
	return Buffer.from(text, "utf-8").toString("base64");
}

/**
 * Copy text to clipboard using OSC52 escape sequence.
 * OSC52 is supported by most modern terminal emulators including:
 * - iTerm2, Kitty, Alacritty, WezTerm, foot, Windows Terminal
 * - tmux (with set-clipboard on), screen (with proper config)
 */
function copyToClipboard(text: string): void {
	const base64Text = toBase64(text);
	// OSC 52 ; c ; <base64-text> ST
	// \x1b] = OSC (Operating System Command)
	// 52 = clipboard operation
	// c = clipboard selection (could also be p for primary, s for secondary)
	// \x07 = ST (String Terminator) - also \x1b\\ works
	const osc52 = `\x1b]52;c;${base64Text}\x07`;
	process.stdout.write(osc52);
}

interface PasteCommand {
	command: string;
	args: string[];
}

/**
 * Resolve the OS-specific commands used to read the system clipboard.
 * Linux returns multiple commands so the tool can fall back when one is missing.
 */
function getPasteCommands(platform: NodeJS.Platform): PasteCommand[] {
	switch (platform) {
		case "darwin":
			return [{ command: "pbpaste", args: [] }];
		case "linux":
			return [
				{ command: "xclip", args: ["-selection", "clipboard", "-o"] },
				{ command: "wl-paste", args: [] },
			];
		case "win32":
			return [
				{
					command: "powershell.exe",
					args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard"],
				},
			];
		default:
			return [];
	}
}

/**
 * Read the user's system clipboard text using the first available OS command.
 * Throws when the platform is unsupported or every candidate command fails.
 */
function readFromClipboard(): string {
	const commands = getPasteCommands(process.platform);
	if (commands.length === 0) {
		throw new Error(`Clipboard read is not supported on ${process.platform}.`);
	}

	const errors: string[] = [];
	for (const cmd of commands) {
		const result = spawnSync(cmd.command, cmd.args, { encoding: "utf-8" });
		if (result.error) {
			errors.push(`${cmd.command}: ${result.error.message}`);
			continue;
		}
		if (result.status !== 0) {
			const stderr = (result.stderr ?? "").toString().trim();
			errors.push(`${cmd.command} exited with ${result.status}${stderr ? `: ${stderr}` : ""}`);
			continue;
		}
		return (result.stdout ?? "").toString();
	}
	throw new Error(`Failed to read clipboard. ${errors.join("; ")}`);
}

export default function clipboardExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "copy_to_clipboard",
		label: "Copy to Clipboard",
		description:
			"Copy text to the user's system clipboard. Use this when the user asks you to " +
			"put something in their clipboard, write a draft reply to clipboard, or copy any " +
			"generated text for easy pasting. The text will be available for pasting immediately.",
		parameters: Type.Object({
			text: Type.String({
				description: "The text to copy to the clipboard",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { text } = params;

			if (!text || text.trim().length === 0) {
				return {
					content: [{ type: "text", text: "Error: No text provided to copy." }],
					details: { success: false, error: "empty_text" },
				};
			}

			try {
				copyToClipboard(text);

				const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;
				const charCount = text.length;

				if (ctx.hasUI) {
					ctx.ui.notify(`Copied ${charCount} characters to clipboard`, "info");
				}

				return {
					content: [
						{
							type: "text",
							text: `Successfully copied ${charCount} characters to clipboard.\n\nPreview:\n${preview}`,
						},
					],
					details: {
						success: true,
						characterCount: charCount,
						preview,
					},
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Failed to copy to clipboard: ${errorMessage}` }],
					details: { success: false, error: errorMessage },
				};
			}
		},
	});

	pi.registerTool({
		name: "paste_from_clipboard",
		label: "Paste from Clipboard",
		description:
			"Read the current text contents of the user's system clipboard. Use this when the user " +
			"asks you to read, paste, summarize, translate, or otherwise act on whatever they just " +
			"copied. Uses pbpaste on macOS, xclip or wl-paste on Linux, and PowerShell Get-Clipboard " +
			"on Windows.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const text = readFromClipboard();

				if (!text || text.trim().length === 0) {
					return {
						content: [{ type: "text", text: "Clipboard is empty." }],
						details: { success: false, error: "empty_clipboard" },
					};
				}

				const charCount = text.length;
				const preview = text.length > 100 ? `${text.slice(0, 100)}...` : text;

				if (ctx.hasUI) {
					ctx.ui.notify(`Pasted ${charCount} characters from clipboard`, "info");
				}

				return {
					content: [
						{
							type: "text",
							text: `Pasted ${charCount} characters from clipboard.\n\n${text}`,
						},
					],
					details: {
						success: true,
						characterCount: charCount,
						preview,
					},
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				return {
					content: [{ type: "text", text: `Failed to paste from clipboard: ${errorMessage}` }],
					details: { success: false, error: errorMessage },
				};
			}
		},
	});
}
