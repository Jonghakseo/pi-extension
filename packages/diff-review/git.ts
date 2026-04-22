import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
	ChangeStatus,
	ReviewCommitInfo,
	ReviewFile,
	ReviewFileComparison,
	ReviewFileContents,
	ReviewFileKind,
	ReviewScope,
} from "./types.js";

interface ChangedPath {
	status: ChangeStatus;
	oldPath: string | null;
	newPath: string | null;
}

interface ReviewBaseInfo {
	mergeBase: string;
	baseRef: string;
}

interface WorkingTreeStatusInfo {
	hasChanges: boolean;
	hasReviewableChanges: boolean;
	hasUntracked: boolean;
	hasTrackedDeletions: boolean;
	hasRenames: boolean;
	untrackedPaths: string[];
}

const WORKING_TREE_COMMIT_SHA = "__pi_working_tree__";
const WORKING_TREE_COMMIT_SHORT_SHA = "WT";
const WORKING_TREE_COMMIT_SUBJECT = "Uncommitted changes";

export function isWorkingTreeCommitSha(sha: string): boolean {
	return sha === WORKING_TREE_COMMIT_SHA;
}

function createWorkingTreeCommitInfo(): ReviewCommitInfo {
	return {
		sha: WORKING_TREE_COMMIT_SHA,
		shortSha: WORKING_TREE_COMMIT_SHORT_SHA,
		subject: WORKING_TREE_COMMIT_SUBJECT,
		authorName: "",
		authorDate: "",
		kind: "working-tree",
	};
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd: repoRoot });
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

async function runBashAllowFailure(pi: ExtensionAPI, repoRoot: string, script: string): Promise<string> {
	const result = await pi.exec("bash", ["-lc", script], { cwd: repoRoot });
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) {
		throw new Error("Not inside a git repository.");
	}
	return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
	return result.code === 0;
}

async function currentBranch(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd: repoRoot });
	return result.code === 0 ? result.stdout.trim() || "HEAD" : "HEAD";
}

async function getUpstreamRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
	const output = await runGitAllowFailure(pi, repoRoot, [
		"rev-parse",
		"--abbrev-ref",
		"--symbolic-full-name",
		"@{upstream}",
	]);
	const value = output.trim();
	return value.length > 0 ? value : null;
}

async function getOriginHeadRef(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
	const output = await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	const value = output.trim();
	return value.length > 0 ? value : null;
}

function isSameBranchRef(ref: string, branch: string): boolean {
	if (!branch || branch === "HEAD") return false;
	return ref === branch || ref.endsWith(`/${branch}`);
}

async function findReviewBase(pi: ExtensionAPI, repoRoot: string): Promise<ReviewBaseInfo | null> {
	const branch = await currentBranch(pi, repoRoot);
	const candidates: string[] = [];
	const upstreamRef = await getUpstreamRef(pi, repoRoot);
	if (upstreamRef && !isSameBranchRef(upstreamRef, branch)) {
		candidates.push(upstreamRef);
	}

	const originHeadRef = await getOriginHeadRef(pi, repoRoot);
	if (originHeadRef) {
		candidates.push(originHeadRef);
	}

	candidates.push("origin/main", "origin/master", "origin/develop", "main", "master", "develop");

	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		const mergeBase = (await runGitAllowFailure(pi, repoRoot, ["merge-base", "HEAD", candidate])).trim();
		if (mergeBase.length > 0) {
			return { mergeBase, baseRef: candidate };
		}
	}

	return null;
}

function parseNameStatusLine(parts: string[]): ChangedPath | null {
	const code = (parts[0] ?? "")[0];

	if (code === "R") {
		const oldPath = parts[1] ?? null;
		const newPath = parts[2] ?? null;
		if (oldPath == null || newPath == null) return null;
		return { status: "renamed", oldPath, newPath };
	}

	const path = parts[1] ?? null;
	if (path == null) return null;

	if (code === "M") return { status: "modified", oldPath: path, newPath: path };
	if (code === "A") return { status: "added", oldPath: null, newPath: path };
	if (code === "D") return { status: "deleted", oldPath: path, newPath: null };
	return null;
}

function parseNameStatus(output: string): ChangedPath[] {
	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const changes: ChangedPath[] = [];
	for (const line of lines) {
		const change = parseNameStatusLine(line.split("\t"));
		if (change != null) changes.push(change);
	}
	return changes;
}

function parseStatusPorcelainZ(output: string): WorkingTreeStatusInfo {
	const info: WorkingTreeStatusInfo = {
		hasChanges: false,
		hasReviewableChanges: false,
		hasUntracked: false,
		hasTrackedDeletions: false,
		hasRenames: false,
		untrackedPaths: [],
	};
	const tokens = output.split("\0");

	for (let index = 0; index < tokens.length; ) {
		const token = tokens[index] ?? "";
		if (token.length === 0) {
			index += 1;
			continue;
		}

		const code = token.slice(0, 2);
		const path = token.slice(3);
		const isRenameOrCopy = code.includes("R") || code.includes("C");
		const isReviewablePath = code !== "!!" && path.length > 0 && isIncludedReviewPath(path);
		if (code !== "!!") {
			info.hasChanges = true;
		}
		if (isReviewablePath) {
			info.hasReviewableChanges = true;
		}
		if (code === "??") {
			if (isReviewablePath) {
				info.hasUntracked = true;
				info.untrackedPaths.push(path);
			}
		} else if (isReviewablePath) {
			if (code.includes("D")) info.hasTrackedDeletions = true;
			if (isRenameOrCopy) info.hasRenames = true;
		}

		index += isRenameOrCopy ? 2 : 1;
	}

	return info;
}

async function getWorkingTreeStatusInfo(pi: ExtensionAPI, repoRoot: string): Promise<WorkingTreeStatusInfo> {
	const output = await runGitAllowFailure(pi, repoRoot, ["status", "--porcelain=1", "--untracked-files=all", "-z"]);
	return parseStatusPorcelainZ(output);
}

function toDisplayPath(change: ChangedPath): string {
	if (change.status === "renamed") {
		return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
	}
	return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath): ReviewFileComparison {
	return {
		status: change.status,
		oldPath: change.oldPath,
		newPath: change.newPath,
		displayPath: toDisplayPath(change),
		hasOriginal: change.oldPath != null,
		hasModified: change.newPath != null,
	};
}

function buildBranchFileId(path: string, hasWorkingTreeFile: boolean, gitDiff: ReviewFileComparison): string {
	return ["branch", path, hasWorkingTreeFile ? "working" : "gone", gitDiff.displayPath].join("::");
}

function buildCommitFileId(sha: string, comparison: ReviewFileComparison): string {
	return ["commit", sha, comparison.displayPath].join("::");
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
	const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
	if (result.code !== 0) {
		return "";
	}
	return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
	try {
		return await readFile(join(repoRoot, path), "utf8");
	} catch {
		return "";
	}
}

async function getWorkingTreeBytes(repoRoot: string, path: string): Promise<Buffer | null> {
	try {
		return await readFile(join(repoRoot, path));
	} catch {
		return null;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function getRevisionBytes(
	pi: ExtensionAPI,
	repoRoot: string,
	revision: string,
	path: string,
): Promise<Buffer | null> {
	const spec = shellQuote(`${revision}:${path}`);
	const result = await pi.exec("bash", ["-lc", `git show ${spec} | base64 | tr -d '\\n'`], { cwd: repoRoot });
	if (result.code !== 0) return null;
	const encoded = (result.stdout ?? "").trim();
	try {
		return Buffer.from(encoded, "base64");
	} catch {
		return null;
	}
}

const imageMimeTypes = new Map<string, string>([
	[".avif", "image/avif"],
	[".bmp", "image/bmp"],
	[".gif", "image/gif"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".webp", "image/webp"],
]);

const binaryExtensions = new Set([
	".7z",
	".a",
	".avi",
	".avif",
	".bin",
	".bmp",
	".class",
	".dll",
	".dylib",
	".eot",
	".exe",
	".gif",
	".gz",
	".ico",
	".jar",
	".jpeg",
	".jpg",
	".lockb",
	".map",
	".mov",
	".mp3",
	".mp4",
	".o",
	".otf",
	".pdf",
	".png",
	".pyc",
	".so",
	".svgz",
	".tar",
	".ttf",
	".wasm",
	".webm",
	".webp",
	".woff",
	".woff2",
	".zip",
]);

function classifyFilePath(path: string): { kind: ReviewFileKind; mimeType: string | null } {
	const extension = extname(path.toLowerCase());
	const mimeType = imageMimeTypes.get(extension) ?? null;
	if (mimeType != null) return { kind: "image", mimeType };
	if (binaryExtensions.has(extension)) return { kind: "binary", mimeType: null };
	return { kind: "text", mimeType: null };
}

function isIncludedReviewPath(path: string): boolean {
	const lowerPath = path.toLowerCase();
	const fileName = lowerPath.split("/").pop() ?? lowerPath;
	if (fileName.length === 0) return false;
	if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;
	return true;
}

function bufferToDataUrl(buffer: Buffer, mimeType: string): string {
	return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function toReviewFile(
	change: ChangedPath,
	options: { id: string; worktreeStatus: ChangeStatus | null; hasWorkingTreeFile: boolean },
): ReviewFile {
	const comparison = toComparison(change);
	const path = change.newPath ?? change.oldPath ?? comparison.displayPath;
	const meta = classifyFilePath(path);
	return {
		id: options.id,
		path,
		worktreeStatus: options.worktreeStatus,
		hasWorkingTreeFile: options.hasWorkingTreeFile,
		inGitDiff: true,
		gitDiff: comparison,
		kind: meta.kind,
		mimeType: meta.mimeType,
	};
}

async function loadBinarySideFromWorkingTree(
	repoRoot: string,
	path: string | null,
	mimeType: string | null,
): Promise<{ exists: boolean; previewUrl: string | null }> {
	if (path == null) return { exists: false, previewUrl: null };
	const bytes = await getWorkingTreeBytes(repoRoot, path);
	if (bytes == null) return { exists: false, previewUrl: null };
	return { exists: true, previewUrl: mimeType ? bufferToDataUrl(bytes, mimeType) : null };
}

async function loadBinarySideFromRevision(
	pi: ExtensionAPI,
	repoRoot: string,
	revision: string,
	path: string | null,
	mimeType: string | null,
): Promise<{ exists: boolean; previewUrl: string | null }> {
	if (path == null) return { exists: false, previewUrl: null };
	const bytes = await getRevisionBytes(pi, repoRoot, revision, path);
	if (bytes == null) return { exists: false, previewUrl: null };
	return { exists: true, previewUrl: mimeType ? bufferToDataUrl(bytes, mimeType) : null };
}

function mergeChangedPaths(...groups: ChangedPath[][]): ChangedPath[] {
	const merged = new Map<string, ChangedPath>();
	for (const group of groups) {
		for (const change of group) {
			const key = change.newPath ?? change.oldPath ?? "";
			if (key.length === 0) continue;
			merged.set(key, change);
		}
	}
	return [...merged.values()];
}

function toUntrackedChangedPaths(paths: string[]): ChangedPath[] {
	return paths.map((path) => ({ status: "added", oldPath: null, newPath: path }) satisfies ChangedPath);
}

function shouldNormalizeBranchChanges(
	trackedChanges: ChangedPath[],
	workingTreeStatus: WorkingTreeStatusInfo,
): boolean {
	if (workingTreeStatus.hasRenames) return true;
	if (!workingTreeStatus.hasUntracked) return false;
	return trackedChanges.some((change) => change.status === "deleted");
}

async function getTrackedBranchReviewChanges(
	pi: ExtensionAPI,
	repoRoot: string,
	branchComparisonBase: string,
): Promise<ChangedPath[]> {
	return parseNameStatus(
		await runGitAllowFailure(pi, repoRoot, [
			"diff",
			"--find-renames",
			"-M",
			"--name-status",
			branchComparisonBase,
			"--",
		]),
	);
}

async function getWorkingTreeSnapshotChanges(
	pi: ExtensionAPI,
	repoRoot: string,
	baseRevision: string | null,
): Promise<ChangedPath[]> {
	const scriptLines = [
		"set -euo pipefail",
		'tmp_index=$(mktemp "/tmp/pi-diff-review-index.XXXXXX")',
		"trap 'rm -f \"$tmp_index\"' EXIT",
		'export GIT_INDEX_FILE="$tmp_index"',
	];
	if (baseRevision != null) {
		scriptLines.push(`git read-tree ${shellQuote(baseRevision)}`);
	} else {
		scriptLines.push('rm -f "$tmp_index"');
	}
	scriptLines.push("git add -A -- .");
	scriptLines.push(
		baseRevision != null
			? `git diff --cached --find-renames -M --name-status ${shellQuote(baseRevision)} --`
			: "git diff --cached --find-renames -M --name-status --root --",
	);
	const output = await runBashAllowFailure(pi, repoRoot, scriptLines.join("\n"));
	return parseNameStatus(output);
}

async function getBranchReviewChanges(
	pi: ExtensionAPI,
	repoRoot: string,
	branchComparisonBase: string | null,
	workingTreeStatus: WorkingTreeStatusInfo,
): Promise<ChangedPath[]> {
	if (!branchComparisonBase) return [];
	const trackedChanges = await getTrackedBranchReviewChanges(pi, repoRoot, branchComparisonBase);
	if (shouldNormalizeBranchChanges(trackedChanges, workingTreeStatus)) {
		return getWorkingTreeSnapshotChanges(pi, repoRoot, branchComparisonBase);
	}
	return mergeChangedPaths(trackedChanges, toUntrackedChangedPaths(workingTreeStatus.untrackedPaths));
}

async function getWorkingTreeReviewChanges(
	pi: ExtensionAPI,
	repoRoot: string,
	repositoryHasHead: boolean,
): Promise<ChangedPath[]> {
	return getWorkingTreeSnapshotChanges(pi, repoRoot, repositoryHasHead ? "HEAD" : null);
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
	return a.path.localeCompare(b.path);
}

function toBranchReviewFile(change: ChangedPath): ReviewFile {
	const comparison = toComparison(change);
	const path = change.newPath ?? change.oldPath ?? comparison.displayPath;
	return toReviewFile(change, {
		id: buildBranchFileId(path, change.newPath != null, comparison),
		worktreeStatus: change.status,
		hasWorkingTreeFile: change.newPath != null,
	});
}

export async function getReviewWindowData(
	pi: ExtensionAPI,
	cwd: string,
): Promise<{
	repoRoot: string;
	files: ReviewFile[];
	commits: ReviewCommitInfo[];
	branchBaseRef: string | null;
	branchMergeBaseSha: string | null;
	repositoryHasHead: boolean;
}> {
	const repoRoot = await getRepoRoot(pi, cwd);
	const repositoryHasHead = await hasHead(pi, repoRoot);
	const reviewBase = repositoryHasHead ? await findReviewBase(pi, repoRoot) : null;
	const branchComparisonBase = reviewBase?.mergeBase ?? (repositoryHasHead ? "HEAD" : null);
	const workingTreeStatus = await getWorkingTreeStatusInfo(pi, repoRoot);
	const branchChanges = repositoryHasHead
		? await getBranchReviewChanges(pi, repoRoot, branchComparisonBase, workingTreeStatus)
		: await getWorkingTreeReviewChanges(pi, repoRoot, false);
	const files = branchChanges
		.filter((change) => isIncludedReviewPath(change.newPath ?? change.oldPath ?? ""))
		.map(toBranchReviewFile)
		.sort(compareReviewFiles);
	const commits = reviewBase ? await listRangeCommits(pi, repoRoot, `${reviewBase.mergeBase}..HEAD`, 100) : [];
	const workingTreeCommit = workingTreeStatus.hasReviewableChanges ? [createWorkingTreeCommitInfo()] : [];
	const fallbackCommits =
		repositoryHasHead && files.length === 0 && commits.length === 0 && !workingTreeStatus.hasReviewableChanges
			? await listRangeCommits(pi, repoRoot, "HEAD", 20)
			: commits;

	return {
		repoRoot,
		files,
		commits: [...workingTreeCommit, ...fallbackCommits],
		branchBaseRef: reviewBase?.baseRef ?? null,
		branchMergeBaseSha: branchComparisonBase,
		repositoryHasHead,
	};
}

export async function listRangeCommits(
	pi: ExtensionAPI,
	repoRoot: string,
	range: string,
	limit: number,
): Promise<ReviewCommitInfo[]> {
	const sep = "\x1f";
	const format = ["%H", "%h", "%s", "%an", "%aI"].join(sep);
	const output = await runGitAllowFailure(pi, repoRoot, ["log", `-${limit}`, `--format=${format}`, range]);
	return output
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [sha, shortSha, subject, authorName, authorDate] = line.split(sep);
			return {
				sha: sha ?? "",
				shortSha: shortSha ?? (sha ?? "").slice(0, 7),
				subject: subject ?? "",
				authorName: authorName ?? "",
				authorDate: authorDate ?? "",
				kind: "commit",
			} satisfies ReviewCommitInfo;
		})
		.filter((commit) => commit.sha.length > 0);
}

export async function getCommitFiles(pi: ExtensionAPI, repoRoot: string, sha: string): Promise<ReviewFile[]> {
	if (isWorkingTreeCommitSha(sha)) {
		const repositoryHasHead = await hasHead(pi, repoRoot);
		const changes = (await getWorkingTreeReviewChanges(pi, repoRoot, repositoryHasHead)).filter((change) =>
			isIncludedReviewPath(change.newPath ?? change.oldPath ?? ""),
		);
		return changes
			.map((change): ReviewFile => {
				const comparison = toComparison(change);
				return toReviewFile(change, {
					id: buildCommitFileId(sha, comparison),
					worktreeStatus: change.status,
					hasWorkingTreeFile: change.newPath != null,
				});
			})
			.sort(compareReviewFiles);
	}

	const output = await runGitAllowFailure(pi, repoRoot, [
		"diff-tree",
		"--root",
		"--find-renames",
		"-M",
		"--name-status",
		"--no-commit-id",
		"-r",
		sha,
	]);
	const changes = parseNameStatus(output).filter((change) =>
		isIncludedReviewPath(change.newPath ?? change.oldPath ?? ""),
	);
	return changes
		.map((change): ReviewFile => {
			const comparison = toComparison(change);
			return toReviewFile(change, {
				id: buildCommitFileId(sha, comparison),
				worktreeStatus: null,
				hasWorkingTreeFile: false,
			});
		})
		.sort(compareReviewFiles);
}

export async function loadReviewFileContents(
	pi: ExtensionAPI,
	repoRoot: string,
	file: ReviewFile,
	scope: ReviewScope,
	commitSha: string | null = null,
	branchMergeBaseSha: string | null = null,
): Promise<ReviewFileContents> {
	const emptyBinaryContents: ReviewFileContents = {
		originalContent: "",
		modifiedContent: "",
		kind: file.kind,
		mimeType: file.mimeType,
		originalExists: false,
		modifiedExists: false,
		originalPreviewUrl: null,
		modifiedPreviewUrl: null,
	};

	if (file.kind !== "text") {
		if (scope === "all") {
			const path = file.gitDiff?.newPath ?? (file.hasWorkingTreeFile ? file.path : null);
			const modifiedSide = file.hasWorkingTreeFile
				? await loadBinarySideFromWorkingTree(repoRoot, path, file.mimeType)
				: await loadBinarySideFromRevision(pi, repoRoot, "HEAD", path, file.mimeType);
			return {
				...emptyBinaryContents,
				modifiedExists: modifiedSide.exists,
				modifiedPreviewUrl: modifiedSide.previewUrl,
			};
		}

		const comparison = file.gitDiff;
		if (comparison == null) return emptyBinaryContents;

		if (scope === "commits") {
			if (!commitSha) return emptyBinaryContents;
			if (isWorkingTreeCommitSha(commitSha)) {
				const repositoryHasHead = await hasHead(pi, repoRoot);
				const originalSide = repositoryHasHead
					? await loadBinarySideFromRevision(pi, repoRoot, "HEAD", comparison.oldPath, file.mimeType)
					: { exists: false, previewUrl: null };
				const modifiedSide = file.hasWorkingTreeFile
					? await loadBinarySideFromWorkingTree(repoRoot, comparison.newPath, file.mimeType)
					: { exists: false, previewUrl: null };
				return {
					...emptyBinaryContents,
					originalExists: originalSide.exists,
					modifiedExists: modifiedSide.exists,
					originalPreviewUrl: originalSide.previewUrl,
					modifiedPreviewUrl: modifiedSide.previewUrl,
				};
			}
			const originalSide = await loadBinarySideFromRevision(
				pi,
				repoRoot,
				`${commitSha}^`,
				comparison.oldPath,
				file.mimeType,
			);
			const modifiedSide = await loadBinarySideFromRevision(pi, repoRoot, commitSha, comparison.newPath, file.mimeType);
			return {
				...emptyBinaryContents,
				originalExists: originalSide.exists,
				modifiedExists: modifiedSide.exists,
				originalPreviewUrl: originalSide.previewUrl,
				modifiedPreviewUrl: modifiedSide.previewUrl,
			};
		}

		if (!branchMergeBaseSha) return emptyBinaryContents;
		const originalSide = await loadBinarySideFromRevision(
			pi,
			repoRoot,
			branchMergeBaseSha,
			comparison.oldPath,
			file.mimeType,
		);
		const modifiedSide = file.hasWorkingTreeFile
			? await loadBinarySideFromWorkingTree(repoRoot, comparison.newPath, file.mimeType)
			: await loadBinarySideFromRevision(pi, repoRoot, "HEAD", comparison.newPath, file.mimeType);
		return {
			...emptyBinaryContents,
			originalExists: originalSide.exists,
			modifiedExists: modifiedSide.exists,
			originalPreviewUrl: originalSide.previewUrl,
			modifiedPreviewUrl: modifiedSide.previewUrl,
		};
	}

	if (scope === "all") {
		const path = file.gitDiff?.newPath ?? (file.hasWorkingTreeFile ? file.path : null);
		const content =
			path == null
				? ""
				: file.hasWorkingTreeFile
					? await getWorkingTreeContent(repoRoot, path)
					: await getRevisionContent(pi, repoRoot, "HEAD", path);
		return {
			originalContent: content,
			modifiedContent: content,
			kind: file.kind,
			mimeType: file.mimeType,
			originalExists: path != null,
			modifiedExists: path != null,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		};
	}

	const comparison = file.gitDiff;
	if (comparison == null) {
		return {
			originalContent: "",
			modifiedContent: "",
			kind: file.kind,
			mimeType: file.mimeType,
			originalExists: false,
			modifiedExists: false,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		};
	}

	if (scope === "commits") {
		if (!commitSha) {
			return {
				originalContent: "",
				modifiedContent: "",
				kind: file.kind,
				mimeType: file.mimeType,
				originalExists: false,
				modifiedExists: false,
				originalPreviewUrl: null,
				modifiedPreviewUrl: null,
			};
		}
		if (isWorkingTreeCommitSha(commitSha)) {
			const repositoryHasHead = await hasHead(pi, repoRoot);
			const originalContent =
				repositoryHasHead && comparison.oldPath != null
					? await getRevisionContent(pi, repoRoot, "HEAD", comparison.oldPath)
					: "";
			const modifiedContent =
				comparison.newPath == null
					? ""
					: file.hasWorkingTreeFile
						? await getWorkingTreeContent(repoRoot, comparison.newPath)
						: "";
			return {
				originalContent,
				modifiedContent,
				kind: file.kind,
				mimeType: file.mimeType,
				originalExists: repositoryHasHead && comparison.oldPath != null,
				modifiedExists: comparison.newPath != null,
				originalPreviewUrl: null,
				modifiedPreviewUrl: null,
			};
		}
		const originalContent =
			comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, `${commitSha}^`, comparison.oldPath);
		const modifiedContent =
			comparison.newPath == null ? "" : await getRevisionContent(pi, repoRoot, commitSha, comparison.newPath);
		return {
			originalContent,
			modifiedContent,
			kind: file.kind,
			mimeType: file.mimeType,
			originalExists: comparison.oldPath != null,
			modifiedExists: comparison.newPath != null,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		};
	}

	if (!branchMergeBaseSha) {
		return {
			originalContent: "",
			modifiedContent: "",
			kind: file.kind,
			mimeType: file.mimeType,
			originalExists: false,
			modifiedExists: false,
			originalPreviewUrl: null,
			modifiedPreviewUrl: null,
		};
	}

	const originalContent =
		comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, branchMergeBaseSha, comparison.oldPath);
	const modifiedContent =
		comparison.newPath == null
			? ""
			: file.hasWorkingTreeFile
				? await getWorkingTreeContent(repoRoot, comparison.newPath)
				: await getRevisionContent(pi, repoRoot, "HEAD", comparison.newPath);
	return {
		originalContent,
		modifiedContent,
		kind: file.kind,
		mimeType: file.mimeType,
		originalExists: comparison.oldPath != null,
		modifiedExists: comparison.newPath != null,
		originalPreviewUrl: null,
		modifiedPreviewUrl: null,
	};
}

export const __testing = {
	parseStatusPorcelainZ,
	shouldNormalizeBranchChanges,
};
