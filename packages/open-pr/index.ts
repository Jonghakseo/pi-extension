import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";

interface BrowserCommand {
	command: string;
	args: string[];
}

export function parsePrViewUrl(stdout: string): string | null {
	try {
		const parsed = JSON.parse(stdout) as { url?: unknown };
		return typeof parsed.url === "string" && parsed.url.trim().length > 0 ? parsed.url.trim() : null;
	} catch {
		return null;
	}
}

export function resolveBrowserOpenCommand(targetPlatform: NodeJS.Platform, url: string): BrowserCommand {
	if (targetPlatform === "darwin") {
		return { command: "open", args: [url] };
	}
	if (targetPlatform === "win32") {
		return { command: "cmd", args: ["/c", "start", "", url] };
	}
	return { command: "xdg-open", args: [url] };
}

export function formatPrLookupError(error: string, branch: string | null): string {
	const detail = error.trim() || "Unknown gh error";
	const lowerDetail = detail.toLowerCase();

	if (lowerDetail.includes("no pull requests found")) {
		return `No pull request found for the current branch${branch ? ` (${branch})` : ""}.`;
	}

	if (
		lowerDetail.includes("not logged into any github hosts") ||
		lowerDetail.includes("authentication failed") ||
		lowerDetail.includes("gh auth login") ||
		lowerDetail.includes("authentication required")
	) {
		return `GitHub CLI authentication failed: ${detail}`;
	}

	if (
		lowerDetail.includes("could not resolve to a repository") ||
		lowerDetail.includes("failed to determine base repo") ||
		lowerDetail.includes("no git remotes found") ||
		lowerDetail.includes("not a git repository")
	) {
		return `GitHub repository lookup failed: ${detail}`;
	}

	return `Failed to resolve pull request${branch ? ` for ${branch}` : ""}: ${detail}`;
}

function notify(ctx: ExtensionContext, message: string, type: NotifyLevel): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}

	if (type === "error") {
		// biome-ignore lint/suspicious/noConsole: non-UI command fallback needs terminal output.
		console.error(message);
		return;
	}

	// biome-ignore lint/suspicious/noConsole: non-UI command fallback needs terminal output.
	console.log(message);
}

async function gitRoot(pi: ExtensionAPI, cwd: string): Promise<string | null> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) return null;
	const root = (result.stdout ?? "").trim();
	return root || null;
}

async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<{ branch: string | null; error: string | null }> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
	if (result.code !== 0) {
		const detail = (result.stderr ?? result.stdout ?? "").trim() || "Unknown git error";
		return { branch: null, error: `Failed to determine current branch: ${detail}` };
	}

	const branch = (result.stdout ?? "").trim();
	if (!branch) {
		return { branch: null, error: "No current branch detected (detached HEAD)." };
	}

	return { branch, error: null };
}

export function createOpenPrHandler(pi: ExtensionAPI) {
	return async (_args: string, ctx: ExtensionContext) => {
		const root = await gitRoot(pi, ctx.cwd);
		if (!root) {
			notify(ctx, "Not a git repository.", "error");
			return;
		}

		const branchResult = await currentBranch(pi, root);
		if (!branchResult.branch) {
			notify(ctx, branchResult.error ?? "Failed to determine current branch.", "error");
			return;
		}

		const prResult = await pi.exec("gh", ["pr", "view", "--json", "url"], { cwd: root });
		if (prResult.code !== 0) {
			const detail = (prResult.stderr ?? prResult.stdout ?? "").trim() || "Unknown gh error";
			notify(ctx, formatPrLookupError(detail, branchResult.branch), "error");
			return;
		}

		const url = parsePrViewUrl(prResult.stdout ?? "");
		if (!url) {
			notify(ctx, "Failed to parse PR URL from `gh pr view --json url`.", "error");
			return;
		}

		const browser = resolveBrowserOpenCommand(process.platform, url);
		const openResult = await pi.exec(browser.command, browser.args, { cwd: root });
		if (openResult.code !== 0) {
			const detail = (openResult.stderr ?? openResult.stdout ?? "").trim() || "Unknown browser error";
			notify(ctx, `Failed to open browser: ${detail}`, "error");
			return;
		}

		notify(ctx, `Opened PR for ${branchResult.branch}: ${url}`, "info");
	};
}

export default function openPrExtension(pi: ExtensionAPI) {
	pi.registerCommand("open-pr", {
		description: "Open the current branch pull request in your browser via GitHub CLI",
		handler: createOpenPrHandler(pi),
	});
}
