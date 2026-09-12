import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryScope, MemoryTier } from "./types.ts";

export const MEMORY_TIERS: readonly MemoryTier[] = ["profile", "log", "note"];

export function memoryTierRank(tier: MemoryTier): number {
	return MEMORY_TIERS.indexOf(tier);
}

// ── Paths ────────────────────────────────────────────────────────────────────

const MEMORY_BASE = path.join(os.homedir(), ".pi", "memory");
const USER_DIR = path.join(MEMORY_BASE, "user");
const PROJECTS_DIR = path.join(MEMORY_BASE, "projects");

function scopeDir(scope: Exclude<MemoryScope, "agent">, projectId?: string): string {
	if (scope === "project") {
		if (!projectId) {
			throw new Error("project scope requires projectId");
		}
		const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "-");
		return path.join(PROJECTS_DIR, safe);
	}
	return USER_DIR;
}

// ── P1-2: Topic Sanitization & Path Confinement ─────────────────────────────

/**
 * Sanitize a topic name into a safe filesystem slug.
 * Strips path traversal sequences, path separators, and non-slug characters.
 * Throws on empty result.
 */
export function sanitizeTopic(topic: string): string {
	const slug = topic
		.replace(/\.\./g, "") // strip traversal
		.replace(/[/\\]/g, "") // strip path separators
		.toLowerCase()
		.replace(/[^a-z0-9\uAC00-\uD7AF\u3131-\u3163-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 50);

	if (!slug) {
		throw new Error(`Invalid topic name: "${topic}"`);
	}
	return slug;
}

function indexPath(scope: Exclude<MemoryScope, "agent">, projectId?: string): string {
	return path.join(scopeDir(scope, projectId), "MEMORY.md");
}

function topicPath(scope: Exclude<MemoryScope, "agent">, projectId: string | undefined, topic: string): string {
	const safe = sanitizeTopic(topic);
	const dir = scopeDir(scope, projectId);
	const resolved = path.resolve(dir, `${safe}.md`);

	// Belt-and-suspenders: verify resolved path stays inside scope directory
	const normalizedDir = path.resolve(dir);
	if (!resolved.startsWith(`${normalizedDir}${path.sep}`)) {
		throw new Error("Path confinement violation: topic escapes scope directory");
	}

	return resolved;
}

// ── Directory Setup ──────────────────────────────────────────────────────────

export async function ensureDir(): Promise<void> {
	await fs.mkdir(USER_DIR, { recursive: true });
	await fs.mkdir(PROJECTS_DIR, { recursive: true });
}

/**
 * P1-1: Ensure the specific scope directory exists.
 * Must be called before acquiring locks on scope-specific files.
 */
async function ensureScopeDir(scope: Exclude<MemoryScope, "agent">, projectId?: string): Promise<void> {
	const dir = scopeDir(scope, projectId);
	await fs.mkdir(dir, { recursive: true });
}

// ── File Locking (per-scope, keyed on MEMORY.md) ────────────────────────────

const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 10;

async function acquireLock(fp: string): Promise<() => Promise<void>> {
	const lp = `${fp}.lock`;
	for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
		try {
			const handle = await fs.open(lp, "wx");
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), "utf8");
				await handle.close();
			} catch (writeErr) {
				await handle.close().catch(() => {});
				await fs.unlink(lp).catch(() => {});
				throw writeErr;
			}
			return async () => {
				await fs.unlink(lp).catch(() => {});
			};
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
				throw new Error(`Lock acquire failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
			const stats = await fs.stat(lp).catch(() => null);
			if (!stats || Date.now() - stats.mtimeMs > LOCK_TTL_MS) {
				await fs.unlink(lp).catch(() => {});
				continue;
			}
			await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
		}
	}
	throw new Error("Memory lock timeout after retries");
}

async function withScopeLock<T>(
	scope: Exclude<MemoryScope, "agent">,
	projectId: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	// P1-1: Ensure scope directory exists before creating the lock file
	await ensureScopeDir(scope, projectId);

	const fp = indexPath(scope, projectId);
	const release = await acquireLock(fp);
	try {
		return await fn();
	} finally {
		await release();
	}
}

// ── Atomic Write ─────────────────────────────────────────────────────────────

async function atomicWrite(fp: string, content: string): Promise<void> {
	const dir = path.dirname(fp);
	await fs.mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.tmp_${crypto.randomBytes(4).toString("hex")}`);
	try {
		await fs.writeFile(tmp, content, "utf8");
		await fs.rename(tmp, fp);
	} catch (err) {
		await fs.unlink(tmp).catch(() => {});
		throw err;
	}
}

// ── Read Helper ──────────────────────────────────────────────────────────────

async function readOrEmpty(fp: string): Promise<string> {
	try {
		return await fs.readFile(fp, "utf8");
	} catch {
		return "";
	}
}

// ── MEMORY.md Index Parsing / Building ───────────────────────────────────────

export interface IndexEntry {
	title: string;
	tier: MemoryTier;
}

export interface IndexSection {
	topic: string; // filename without .md
	entries: IndexEntry[];
}

export function parseIndex(content: string): IndexSection[] {
	const sections: IndexSection[] = [];
	const isV2 = content.includes(INDEX_V2_MARKER);
	let currentTopic: string | null = null;
	let currentEntries: IndexEntry[] = [];

	for (const line of content.split("\n")) {
		const topicMatch = line.match(/^## (.+)\.md\s*$/);
		if (topicMatch) {
			if (currentTopic) sections.push({ topic: currentTopic, entries: currentEntries });
			currentTopic = topicMatch[1];
			currentEntries = [];
			continue;
		}
		const bullet = isV2 ? line.match(/^- \[(profile|log|note)\] (.+)$/) : line.match(/^- (.+)$/);
		if (bullet && currentTopic) {
			currentEntries.push({ title: bullet[isV2 ? 2 : 1], tier: isV2 ? (bullet[1] as MemoryTier) : "profile" });
		}
	}

	if (currentTopic) sections.push({ topic: currentTopic, entries: currentEntries });
	return sections;
}

const INDEX_V2_MARKER = "<!-- memory-layer-index:v2 -->";

function buildIndex(sections: IndexSection[]): string {
	const lines = ["# Memory Index", INDEX_V2_MARKER, ""];
	for (const section of sections) {
		lines.push(`## ${section.topic}.md`);
		for (const entry of section.entries) {
			lines.push(`- [${entry.tier}] ${entry.title}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ── P1-3: Entry Marker Format ────────────────────────────────────────────────
// V2 stores title and tier in one self-contained JSON marker. Legacy @entry
// markers and ## headings remain profile entries and preserve their body verbatim.

const ENTRY_V2_MARKER_PREFIX = "<!-- memory-layer-entry:v2: ";
const ENTRY_MARKER_PREFIX = "<!-- @entry: ";
const ENTRY_MARKER_SUFFIX = " -->";

function isMemoryTier(value: unknown): value is MemoryTier {
	return value === "profile" || value === "log" || value === "note";
}

function encodeEntryMetadata(title: string, tier: MemoryTier): string {
	return Buffer.from(JSON.stringify({ title, tier }), "utf8").toString("base64");
}

function decodeEntryMetadata(encoded: string): { title: string; tier: MemoryTier } | null {
	try {
		const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
		if (typeof parsed.title !== "string" || !isMemoryTier(parsed.tier)) return null;
		return { title: parsed.title, tier: parsed.tier };
	} catch {
		return null;
	}
}

function decodeEntryTitle(encoded: string): string {
	return Buffer.from(encoded, "base64").toString("utf8");
}

function isNewEntryFormat(raw: string): boolean {
	return raw.includes(ENTRY_V2_MARKER_PREFIX) || raw.includes(ENTRY_MARKER_PREFIX);
}

// ── Topic File Parsing / Building ────────────────────────────────────────────

export interface TopicEntry {
	title: string;
	content: string;
	tier: MemoryTier;
}

/** Parse topic file using new marker format. */
function parseTopicFileMarker(raw: string): { heading: string; entries: TopicEntry[] } {
	const lines = raw.split("\n");
	let heading = "";
	const entries: TopicEntry[] = [];
	let curTitle: string | null = null;
	let curTier: MemoryTier = "profile";
	let curBody: string[] = [];

	for (const line of lines) {
		// Parse heading (first # line only)
		if (!heading) {
			const h1 = line.match(/^# (.+)$/);
			if (h1) {
				heading = h1[1];
				continue;
			}
		}

		const isV2Marker = line.startsWith(ENTRY_V2_MARKER_PREFIX) && line.endsWith(ENTRY_MARKER_SUFFIX);
		const isLegacyMarker = line.startsWith(ENTRY_MARKER_PREFIX) && line.endsWith(ENTRY_MARKER_SUFFIX);
		if (isV2Marker || isLegacyMarker) {
			if (curTitle !== null) {
				entries.push({ title: curTitle, content: curBody.join("\n").trim(), tier: curTier });
			}
			const prefix = isV2Marker ? ENTRY_V2_MARKER_PREFIX : ENTRY_MARKER_PREFIX;
			const encoded = line.slice(prefix.length, -ENTRY_MARKER_SUFFIX.length).trim();
			const metadata = isV2Marker ? decodeEntryMetadata(encoded) : null;
			if (metadata) {
				curTitle = metadata.title;
				curTier = metadata.tier;
			} else {
				try {
					curTitle = decodeEntryTitle(encoded);
				} catch {
					curTitle = encoded;
				}
				curTier = "profile";
			}
			curBody = [];
			continue;
		}

		if (curTitle !== null) curBody.push(line);
	}

	if (curTitle !== null) entries.push({ title: curTitle, content: curBody.join("\n").trim(), tier: curTier });
	return { heading, entries };
}

/** Parse topic file using legacy ## heading format (backward compatibility). */
function parseTopicFileLegacy(raw: string): { heading: string; entries: TopicEntry[] } {
	const lines = raw.split("\n");
	let heading = "";
	const entries: TopicEntry[] = [];
	let curTitle: string | null = null;
	let curBody: string[] = [];
	let headingResolved = false;

	for (const line of lines) {
		// Issue 2 fix: only the first non-empty line's H1 is the document heading
		if (!headingResolved) {
			if (line.trim() === "") continue; // skip leading blank lines
			const h1 = line.match(/^# (.+)$/);
			if (h1) {
				heading = h1[1];
				headingResolved = true;
				continue;
			}
			headingResolved = true; // first non-empty line is not H1 — stop looking
		}

		const h2 = line.match(/^## (.+)$/);
		if (h2) {
			if (curTitle) entries.push({ title: curTitle, content: curBody.join("\n").trim(), tier: "profile" });
			curTitle = h2[1];
			curBody = [];
			continue;
		}
		if (curTitle !== null) curBody.push(line);
	}
	if (curTitle) entries.push({ title: curTitle, content: curBody.join("\n").trim(), tier: "profile" });

	return { heading, entries };
}

/**
 * Parse a topic file, auto-detecting format.
 * New marker format takes priority; falls back to legacy ## format.
 */
export function parseTopicFile(raw: string): { heading: string; entries: TopicEntry[] } {
	if (isNewEntryFormat(raw)) return parseTopicFileMarker(raw);
	return parseTopicFileLegacy(raw);
}

/** Build topic file always using new marker format (## safe). */
function buildTopicFile(heading: string, entries: TopicEntry[]): string {
	const lines = [`# ${heading}`, ""];
	for (const entry of entries) {
		lines.push(`${ENTRY_V2_MARKER_PREFIX}${encodeEntryMetadata(entry.title, entry.tier)}${ENTRY_MARKER_SUFFIX}`);
		lines.push(entry.content);
		lines.push("");
	}
	return lines.join("\n");
}

// ── Public API: Save ─────────────────────────────────────────────────────────

export async function saveMemory(
	scope: Exclude<MemoryScope, "agent">,
	projectId: string | undefined,
	topic: string,
	topicHeading: string,
	title: string,
	content: string,
	tier: MemoryTier = "profile",
): Promise<void> {
	const safeTopic = sanitizeTopic(topic);
	const iFp = indexPath(scope, projectId);
	const tFp = topicPath(scope, projectId, safeTopic);

	await withScopeLock(scope, projectId, async () => {
		// 1) append to topic file
		const raw = await readOrEmpty(tFp);
		const parsed = raw ? parseTopicFile(raw) : { heading: topicHeading, entries: [] };
		parsed.entries.push({ title, content, tier });
		await atomicWrite(tFp, buildTopicFile(parsed.heading, parsed.entries));

		// 2) update index
		const idxRaw = await readOrEmpty(iFp);
		const sections = parseIndex(idxRaw);
		let sec = sections.find((s) => s.topic === safeTopic);
		if (!sec) {
			sec = { topic: safeTopic, entries: [] };
			sections.push(sec);
		}
		sec.entries.push({ title, tier });
		await atomicWrite(iFp, buildIndex(sections));
	});
}

// ── Public API: Remove ───────────────────────────────────────────────────────

export async function removeMemory(
	scope: Exclude<MemoryScope, "agent">,
	projectId: string | undefined,
	topic: string,
	title: string,
): Promise<boolean> {
	const safeTopic = sanitizeTopic(topic);
	const iFp = indexPath(scope, projectId);
	const tFp = topicPath(scope, projectId, safeTopic);

	return withScopeLock(scope, projectId, async () => {
		// 1) remove from topic file
		const raw = await readOrEmpty(tFp);
		if (!raw) return false;

		const parsed = parseTopicFile(raw);
		const idx = parsed.entries.findIndex((e) => e.title === title);
		if (idx === -1) return false;

		parsed.entries.splice(idx, 1);
		if (parsed.entries.length === 0) {
			await fs.unlink(tFp).catch(() => {});
		} else {
			await atomicWrite(tFp, buildTopicFile(parsed.heading, parsed.entries));
		}

		// 2) update index — remove only ONE matching entry (Issue 3 fix)
		const idxRaw = await readOrEmpty(iFp);
		const sections = parseIndex(idxRaw);
		const secIdx = sections.findIndex((s) => s.topic === safeTopic);
		if (secIdx !== -1) {
			const sec = sections[secIdx];
			const entryIdx = sec.entries.findIndex((entry) => entry.title === title);
			if (entryIdx !== -1) sec.entries.splice(entryIdx, 1);
			if (sec.entries.length === 0) sections.splice(secIdx, 1);
		}
		await atomicWrite(iFp, buildIndex(sections));
		return true;
	});
}

// ── Public API: Check Existence (P2-2) ───────────────────────────────────────

/**
 * Check if a memory entry exists in a specific persistent scope (without lock).
 * Used for forget ambiguity detection.
 */
export async function memoryExistsInScope(
	scope: Exclude<MemoryScope, "agent">,
	projectId: string | undefined,
	topic: string,
	title: string,
): Promise<boolean> {
	try {
		const entries = await loadTopicEntries(scope, projectId, topic);
		return entries.some((e) => e.title === title);
	} catch {
		return false;
	}
}

// ── Public API: Read ─────────────────────────────────────────────────────────

export async function loadIndex(scope: Exclude<MemoryScope, "agent">, projectId?: string): Promise<IndexSection[]> {
	const raw = await readOrEmpty(indexPath(scope, projectId));
	return parseIndex(raw);
}

export async function readMemoryMd(scope: Exclude<MemoryScope, "agent">, projectId?: string): Promise<string> {
	return readOrEmpty(indexPath(scope, projectId));
}

export async function readTopicFile(
	scope: Exclude<MemoryScope, "agent">,
	projectId: string | undefined,
	topic: string,
): Promise<string> {
	return readOrEmpty(topicPath(scope, projectId, topic));
}

export async function loadTopicEntries(
	scope: Exclude<MemoryScope, "agent">,
	projectId: string | undefined,
	topic: string,
): Promise<TopicEntry[]> {
	const raw = await readTopicFile(scope, projectId, topic);
	if (!raw) return [];
	return parseTopicFile(raw).entries;
}

export async function listTopics(scope: Exclude<MemoryScope, "agent">, projectId?: string): Promise<string[]> {
	const dir = scopeDir(scope, projectId);
	try {
		const files = await fs.readdir(dir);
		return files.filter((f) => f.endsWith(".md") && f !== "MEMORY.md").map((f) => f.replace(/\.md$/, ""));
	} catch {
		return [];
	}
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
	scope: MemoryScope;
	projectId?: string;
	topic: string;
	title: string;
	content: string;
	tier: MemoryTier;
}

export function memoryEntryId(
	scope: MemoryScope,
	projectId: string | undefined,
	topic: string,
	title: string,
	content: string,
): string {
	const key = `${scope}:${projectId ?? ""}:${topic}:${title}:${content}`;
	return crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export async function listPersistentMemories(projectId?: string): Promise<SearchResult[]> {
	const results: SearchResult[] = [];
	const scopes: Array<{ scope: Exclude<MemoryScope, "agent">; pid?: string }> = [
		{ scope: "user" },
		...(projectId ? [{ scope: "project" as const, pid: projectId }] : []),
	];
	for (const { scope, pid } of scopes) {
		const topics = await listTopics(scope, pid);
		for (const topic of topics) {
			const entries = await loadTopicEntries(scope, pid, topic);
			for (const entry of entries) {
				results.push({ scope, projectId: pid, topic, title: entry.title, content: entry.content, tier: entry.tier });
			}
		}
	}
	return results;
}

export function findMemoryInEntries(
	entries: SearchResult[],
	id: string,
	filters: { scope?: MemoryScope; tier?: MemoryTier } = {},
): SearchResult | null {
	return (
		entries.find(
			(entry) =>
				(!filters.scope || entry.scope === filters.scope) &&
				(!filters.tier || entry.tier === filters.tier) &&
				memoryEntryId(entry.scope, entry.projectId, entry.topic, entry.title, entry.content) === id,
		) ?? null
	);
}

export async function findMemoryById(
	id: string,
	projectId?: string,
	filters: { scope?: Exclude<MemoryScope, "agent">; tier?: MemoryTier } = {},
): Promise<SearchResult | null> {
	return findMemoryInEntries(await listPersistentMemories(projectId), id, filters);
}

function tokenizeSearchQuery(query: string): string[] {
	const normalized = query.toLowerCase().trim();
	if (!normalized) return [];
	const splitTokens = normalized
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	const filtered = splitTokens.filter((token) => token.length >= 2);
	const tokens = filtered.length > 0 ? filtered : splitTokens;
	return [...new Set(tokens)];
}

export function scoreMemorySearchMatch(
	query: string,
	target: { topic: string; title: string; content: string },
): number {
	const normalizedQuery = query.toLowerCase().trim();
	if (!normalizedQuery) return 0;

	const topic = target.topic.toLowerCase();
	const title = target.title.toLowerCase();
	const content = target.content.toLowerCase();
	const tokens = tokenizeSearchQuery(normalizedQuery);
	let score = 0;

	if (title.includes(normalizedQuery)) score += 10;
	if (topic.includes(normalizedQuery)) score += 8;
	if (content.includes(normalizedQuery)) score += 6;

	for (const token of tokens) {
		if (title.includes(token)) score += 3;
		if (topic.includes(token)) score += 2;
		if (content.includes(token)) score += 1;
	}

	return score;
}

export function searchMemoryEntries(
	entries: SearchResult[],
	query: string,
	filters: { scope?: MemoryScope; tier?: MemoryTier } = {},
): SearchResult[] {
	const results: Array<SearchResult & { score: number }> = [];
	for (const entry of entries) {
		if (filters.scope && entry.scope !== filters.scope) continue;
		if (filters.tier && entry.tier !== filters.tier) continue;
		const score = scoreMemorySearchMatch(query, entry);
		if (score > 0) results.push({ ...entry, score });
	}
	results.sort(
		(a, b) =>
			memoryTierRank(a.tier) - memoryTierRank(b.tier) ||
			b.score - a.score ||
			a.topic.localeCompare(b.topic) ||
			a.title.localeCompare(b.title),
	);
	return results.map(({ score: _score, ...result }) => result);
}

export async function searchMemories(
	query: string,
	projectId?: string,
	filters: { scope?: Exclude<MemoryScope, "agent">; tier?: MemoryTier } = {},
): Promise<SearchResult[]> {
	return searchMemoryEntries(await listPersistentMemories(projectId), query, filters);
}

// ── Count Helper for Migration Dedup ─────────────────────────────────────────

/**
 * Normalize text for consistent key generation.
 * Trims whitespace and canonicalizes line endings (\r\n → \n).
 */
function normalizeText(s: string): string {
	return s.replace(/\r\n/g, "\n").trim();
}

/**
 * Build a dedup key from title + content with consistent normalization.
 * Both source (raw legacy) and existing (parsed) entries must go through
 * this function to guarantee idempotent comparison.
 */
function makeEntryKey(title: string, content: string): string {
	return `${normalizeText(title)}\0${normalizeText(content)}`;
}

/** Count occurrences of each key in an array. */
function countByKey(keys: string[]): Map<string, number> {
	const map = new Map<string, number>();
	for (const key of keys) {
		map.set(key, (map.get(key) ?? 0) + 1);
	}
	return map;
}

// ── P1-4: Migration from JSON (idempotent, atomic rename) ────────────────────

interface LegacyRecord {
	title: string;
	content: string;
	scope: Exclude<MemoryScope, "agent">;
	projectId?: string;
	status: string;
}

type MigrationTarget = {
	scope: Exclude<MemoryScope, "agent">;
	projectId?: string;
	filePath: string;
	errorPrefix: string;
};

async function migrateLegacyRecords(target: MigrationTarget, records: LegacyRecord[], errors: string[]) {
	const activeRecords = records.filter((r) => r.status === "active");
	const existingEntries = await loadTopicEntries(target.scope, target.projectId, "general");
	const sourceCounts = countByKey(activeRecords.map((r) => makeEntryKey(r.title, r.content)));
	const existingCounts = countByKey(existingEntries.map((e) => makeEntryKey(e.title, e.content)));

	let fileAllSucceeded = true;
	let fileMigrated = 0;

	for (const [key, srcCount] of sourceCounts) {
		const needed = srcCount - (existingCounts.get(key) ?? 0);
		if (needed <= 0) continue;
		const sepIdx = key.indexOf("\0");
		const title = key.slice(0, sepIdx);
		const content = key.slice(sepIdx + 1);

		for (let i = 0; i < needed; i++) {
			try {
				await saveMemory(target.scope, target.projectId, "general", "General", title, content);
				fileMigrated++;
			} catch (error) {
				fileAllSucceeded = false;
				errors.push(`${target.errorPrefix} "${title}": ${error instanceof Error ? error.message : "unknown"}`);
			}
		}
	}

	if (fileAllSucceeded) {
		await fs.rename(target.filePath, `${target.filePath}.bak`);
	}

	return { migrated: fileMigrated, fileAllSucceeded };
}

async function migrateLegacyFile(target: MigrationTarget, errors: string[]) {
	const raw = await fs.readFile(target.filePath, "utf8");
	const records: LegacyRecord[] = JSON.parse(raw);
	return migrateLegacyRecords(target, records, errors);
}

export async function migrateFromJson(): Promise<{ migrated: number; errors: string[] }> {
	let migrated = 0;
	const errors: string[] = [];

	const userJson = path.join(MEMORY_BASE, "user.json");
	try {
		const result = await migrateLegacyFile({ scope: "user", filePath: userJson, errorPrefix: "user" }, errors);
		migrated += result.migrated;
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
			errors.push(`user.json: ${err instanceof Error ? err.message : "unknown"}`);
		}
	}

	try {
		const projectFiles = await fs.readdir(PROJECTS_DIR);
		for (const file of projectFiles) {
			if (!file.endsWith(".json")) continue;
			const projectId = file.replace(/\.json$/, "");
			const filePath = path.join(PROJECTS_DIR, file);
			try {
				const result = await migrateLegacyFile(
					{
						scope: "project",
						projectId,
						filePath,
						errorPrefix: `project "${projectId}"`,
					},
					errors,
				);
				migrated += result.migrated;
			} catch (error) {
				errors.push(`${file}: ${error instanceof Error ? error.message : "unknown"}`);
			}
		}
	} catch {
		// projects dir might not exist yet
	}

	return { migrated, errors };
}
