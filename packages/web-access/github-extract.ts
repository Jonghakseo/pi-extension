import { activityMonitor } from "./activity.js";
import { loadConfigSection, normalizeBoolean } from "./config.js";
import type { ExtractedContent } from "./extract.js";
import { fetchViaApi } from "./github-api.js";

export interface GitHubUrlInfo {
	owner: string;
	repo: string;
	ref?: string;
	refIsFullSha: boolean;
	path?: string;
	type: "root" | "blob" | "tree";
}

interface GitHubConfig {
	enabled: boolean;
}

let cachedConfig: GitHubConfig | null = null;

const GITHUB_DEFAULTS: GitHubConfig = {
	enabled: true,
};

function loadGitHubConfig(): GitHubConfig {
	if (cachedConfig) return cachedConfig;
	cachedConfig = loadConfigSection("github-clone", GITHUB_DEFAULTS, (raw) => {
		const gc = raw.githubClone ?? {};
		return {
			enabled: normalizeBoolean(gc.enabled, GITHUB_DEFAULTS.enabled),
		};
	});
	return cachedConfig;
}

const NON_CODE_SEGMENTS = new Set([
	"issues",
	"pull",
	"pulls",
	"discussions",
	"releases",
	"wiki",
	"actions",
	"settings",
	"security",
	"projects",
	"graphs",
	"compare",
	"commits",
	"tags",
	"branches",
	"stargazers",
	"watchers",
	"network",
	"forks",
	"milestone",
	"labels",
	"packages",
	"codespaces",
	"contribute",
	"community",
	"sponsors",
	"invitations",
	"notifications",
	"insights",
]);

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;

	const segments = parsed.pathname
		.split("/")
		.filter(Boolean)
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");

	if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

	if (segments.length === 2) {
		return { owner, repo, refIsFullSha: false, type: "root" };
	}

	const action = segments[2];
	if (action !== "blob" && action !== "tree") return null;
	if (segments.length < 4) return null;

	const ref = segments[3];
	const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
	const pathParts = segments.slice(4);
	const path = pathParts.length > 0 ? pathParts.join("/") : "";

	return {
		owner,
		repo,
		ref,
		refIsFullSha,
		path,
		type: action as "blob" | "tree",
	};
}

export async function extractGitHub(url: string, signal?: AbortSignal): Promise<ExtractedContent | null> {
	const info = parseGitHubUrl(url);
	if (!info) return null;

	if (signal?.aborted) return null;

	const config = loadGitHubConfig();
	if (!config.enabled) return null;

	const { owner, repo } = info;
	const activityId = activityMonitor.logStart({ type: "fetch", url: `github.com/${owner}/${repo}` });

	const result = await fetchViaApi(url, owner, repo, info);
	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}
	if (result) {
		activityMonitor.logComplete(activityId, 200);
		return result;
	}
	activityMonitor.logError(activityId, "github api fetch failed");
	return null;
}
