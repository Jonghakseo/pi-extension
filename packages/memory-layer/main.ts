import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { loadAgentMemories, removeAgentMemory, saveAgentMemory } from "./agent-store.ts";
import { buildMemoryPrompt } from "./inject.ts";
import { resolveProjectId } from "./project-id.ts";
import {
	ensureDir,
	findMemoryInEntries,
	listPersistentMemories,
	listTopics,
	memoryEntryId,
	migrateFromJson,
	readTopicFile,
	removeMemory,
	type SearchResult,
	sanitizeTopic,
	saveMemory,
	searchMemoryEntries,
} from "./storage.ts";
import {
	type MemoryToolDetails,
	renderForgetCall,
	renderForgetResult,
	renderMemoryListCall,
	renderMemoryListResult,
	renderRecallCall,
	renderRecallResult,
	renderRememberCall,
	renderRememberResult,
} from "./tool-render.ts";
import type { MemoryScope, MemoryTier } from "./types.ts";
import { ForgetParams, MemoryListParams, RecallParams, RememberParams } from "./types.ts";
import {
	MemoryActionMenuComponent,
	MemoryDeleteConfirmComponent,
	MemoryDetailOverlayComponent,
	type MemoryMenuAction,
	MemorySelectorComponent,
} from "./ui.ts";

function resolveCurrentProjectId(cwd: string): string | undefined {
	try {
		return resolveProjectId(cwd).id;
	} catch {
		return undefined;
	}
}

function truncateTitle(content: string, maxLen = 60): string {
	const firstLine = content.split("\n")[0]?.trim() ?? content.trim();
	if (firstLine.length <= maxLen) return firstLine;
	return `${firstLine.slice(0, maxLen - 3)}...`;
}

/** Convert slug to a human-readable heading. */
function slugToHeading(slug: string): string {
	return slug
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/**
 * Normalize topic input from tool callers.
 * Accepts both `general` and `general.md` and always returns a safe slug.
 */
function normalizeTopicInput(topic: string): string {
	const trimmed = topic.trim();
	const withoutMd = trimmed.replace(/\.md$/i, "").trim();
	return sanitizeTopic(withoutMd);
}

async function promptTopic(
	ctx: ExtensionContext,
	scope: MemoryScope,
	projectId: string | undefined,
): Promise<{ slug: string; heading: string } | null> {
	const existing = scope === "agent" ? [] : await listTopics(scope, projectId);
	const options = [...existing, "📝 새 주제 만들기", "취소"];
	const choice = await ctx.ui.select("주제를 선택하세요:", options);
	if (!choice || choice === "취소") return null;

	if (choice !== "📝 새 주제 만들기") {
		return { slug: choice, heading: slugToHeading(choice) };
	}

	const name = await ctx.ui.input("새 주제 이름 (영문 slug 또는 한글):");
	if (!name?.trim()) return null;
	try {
		const trimmedName = name.trim();
		return { slug: sanitizeTopic(trimmedName), heading: trimmedName };
	} catch {
		return null;
	}
}

function parseRememberArgs(raw: string): { scope: MemoryScope; tier: MemoryTier; content: string } {
	const match = raw.match(/^(?:(agent|user|project)\s+)?(?:(profile|log|note)\s+)?([\s\S]+)$/);
	if (!match) return { scope: "project", tier: "profile", content: raw };
	return {
		scope: (match[1] as MemoryScope | undefined) ?? "project",
		tier: (match[2] as MemoryTier | undefined) ?? "profile",
		content: match[3].trim(),
	};
}

function parseMemoryArgs(args: string): { scope?: MemoryScope; tier?: MemoryTier; search?: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const search: string[] = [];
	let scope: MemoryScope | undefined;
	let tier: MemoryTier | undefined;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const scopeValue =
			token.match(/^--scope=(agent|user|project)$/)?.[1] ?? (token === "--scope" ? tokens[++index] : undefined);
		if (scopeValue) {
			if (scopeValue === "agent" || scopeValue === "user" || scopeValue === "project") scope = scopeValue;
			else search.push("--scope", scopeValue);
			continue;
		}
		const tierValue =
			token.match(/^--tier=(profile|log|note)$/)?.[1] ?? (token === "--tier" ? tokens[++index] : undefined);
		if (tierValue) {
			if (tierValue === "profile" || tierValue === "log" || tierValue === "note") tier = tierValue;
			else search.push("--tier", tierValue);
			continue;
		}
		search.push(token);
	}
	return { scope, tier, search: search.join(" ") || undefined };
}

function buildTextResult(text: string, details?: MemoryToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

async function openMemoryDetail(ctx: ExtensionContext, entry: SearchResult): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new MemoryDetailOverlayComponent(tui, theme, entry, () => done()),
		{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
	);
}

async function openMemoryTopicDetail(ctx: ExtensionContext, entry: SearchResult): Promise<void> {
	const fullTopic =
		entry.scope === "agent" ? entry.content : await readTopicFile(entry.scope, entry.projectId, entry.topic);
	await openMemoryDetail(ctx, {
		...entry,
		title: `📁 ${entry.topic}.md (full)`,
		content: fullTopic || "(empty)",
	});
}

function copyMemoryEntry(ctx: ExtensionContext, entry: SearchResult): void {
	try {
		copyToClipboard(`${entry.title}\n\n${entry.content}`);
		ctx.ui.notify("Copied to clipboard", "info");
	} catch (e) {
		ctx.ui.notify(`Copy failed: ${e instanceof Error ? e.message : "unknown"}`, "error");
	}
}

function throwIfProjectScopeInvalid(projectId: string | undefined, scope: MemoryScope | undefined, action: string) {
	if (scope === "project" && !projectId) {
		throw new Error(`project scope ${action} requires project context (projectId not resolved)`);
	}
}

async function executeRecallById(
	id: string,
	entries: SearchResult[],
	filters: { scope?: MemoryScope; tier?: MemoryTier },
) {
	const entry = findMemoryInEntries(entries, id, filters);
	if (!entry) throw new Error(`Memory not found with id and supplied filters: ${id}`);
	return buildTextResult(`[${entry.scope}/${entry.tier}] ${entry.topic}/${entry.title}\n\n${entry.content}`, {
		kind: "recall-id",
		scope: entry.scope,
		tier: entry.tier,
		topic: entry.topic,
		title: entry.title,
	});
}

function executeRecallQuery(
	query: string,
	entries: SearchResult[],
	filters: { scope?: MemoryScope; tier?: MemoryTier },
) {
	const results = searchMemoryEntries(entries, query, filters);
	const resultDetails: MemoryToolDetails = {
		kind: "recall-query",
		total: results.length,
		matches: results.slice(0, 2).map((result) => ({
			scope: result.scope,
			tier: result.tier,
			topic: result.topic,
			title: result.title,
		})),
	};
	if (results.length === 0) return buildTextResult("No matching memories found.", resultDetails);
	const maxResults = 20;
	const lines = results.slice(0, maxResults).map((result) => {
		const id = memoryEntryId(result.scope, result.projectId, result.topic, result.title, result.content);
		const firstLine = result.content.split("\n")[0] ?? "";
		const snippet = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
		return `- [${id}] [${result.scope}/${result.tier}] ${result.topic}/${result.title}${snippet ? `\n  ${snippet}` : ""}`;
	});
	const shown = Math.min(results.length, maxResults);
	const header =
		results.length > shown
			? `Found ${results.length} memories (showing top ${shown}):`
			: `Found ${results.length} memories:`;
	return buildTextResult(`${header}\n\n${lines.join("\n")}\n\nUse recall with id to view full content.`, resultDetails);
}

function formatMemoryIndex(entries: SearchResult[]): string {
	const sections: string[] = [];
	for (const tier of ["profile", "log", "note"] as const) {
		const tierEntries = entries.filter((entry) => entry.tier === tier);
		if (!tierEntries.length) continue;
		const grouped = new Map<string, SearchResult[]>();
		for (const entry of tierEntries) {
			const key = `${entry.scope}:${entry.topic}`;
			const group = grouped.get(key) ?? [];
			group.push(entry);
			grouped.set(key, group);
		}
		const groups = [...grouped.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, group]) => {
				const [scope, topic] = key.split(":");
				return `[${scope} Memory]\n## ${topic}.md\n${group
					.sort((a, b) => a.title.localeCompare(b.title))
					.map((entry) => `- ${entry.title}`)
					.join("\n")}`;
			});
		sections.push(`### ${tier}\n\n${groups.join("\n\n")}`);
	}
	return sections.join("\n\n");
}

function executeRecallIndex(entries: SearchResult[], filters: { scope?: MemoryScope; tier?: MemoryTier }) {
	const filtered = entries.filter(
		(entry) => (!filters.scope || entry.scope === filters.scope) && (!filters.tier || entry.tier === filters.tier),
	);
	return buildTextResult(formatMemoryIndex(filtered) || "No memories stored.", {
		kind: "recall-index",
		scope: filters.scope,
		tier: filters.tier,
		agent: filtered.filter((entry) => entry.scope === "agent").length,
		user: filtered.filter((entry) => entry.scope === "user").length,
		project: filtered.filter((entry) => entry.scope === "project").length,
		topics: new Set(filtered.map((entry) => `${entry.scope}:${entry.topic}`)).size,
	});
}

async function executeForgetById(id: string, entries: SearchResult[], remove: (entry: SearchResult) => Promise<void>) {
	const target = findMemoryInEntries(entries, id);
	if (!target) throw new Error(`Memory not found by ID: ${id}`);
	await remove(target);
	return buildTextResult(`Deleted from ${target.scope}: ${target.topic} / "${target.title}"`, {
		kind: "forget",
		scope: target.scope,
		tier: target.tier,
		topic: target.topic,
		title: target.title,
	});
}

// ── Extension Entry Point ────────────────────────────────────────────────────

export interface MemoryLayerHandlers {
	onRememberCommand: (args: string, ctx: ExtensionContext) => Promise<void>;
	onMemoryCommand: (args: string, ctx: ExtensionContext) => Promise<void>;
	onSessionStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
	onBeforeAgentStart: (
		event: { systemPrompt: string },
		ctx: ExtensionContext,
	) => Promise<{ systemPrompt: string } | undefined>;
}

/** Registers commands/tools and returns lifecycle handlers; index.ts loads this lazily. */
export function registerMemoryLayer(pi: ExtensionAPI): MemoryLayerHandlers {
	let currentProjectId: string | undefined;
	let migrationDone = false;

	/**
	 * Core save logic shared by /remember command and remember tool.
	 *
	 * @param scope - Explicit storage scope ("agent" | "user" | "project").
	 * @param interactive - If true (default), prompts for topic selection.
	 *   If false, auto-selects "general" topic with no UI prompts.
	 */
	async function saveContent(
		content: string,
		title: string | undefined,
		scope: MemoryScope,
		tier: MemoryTier,
		ctx: ExtensionContext,
		interactive = true,
		topic?: string,
	): Promise<
		{ topic: string; title: string; scope: MemoryScope; tier: MemoryTier } | { cancelled: true } | { error: string }
	> {
		try {
			const displayTitle = title ?? truncateTitle(content);

			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			// Fail-fast: project scope requires a resolved projectId
			if (scope === "project" && !currentProjectId) {
				return { error: "project scope memory requires project context (projectId not resolved)" };
			}

			let topicSlug: string;
			let topicHeading: string;

			if (interactive) {
				// /remember command path: show topic selection UI
				const topicChoice = await promptTopic(ctx, scope, scope === "project" ? currentProjectId : undefined);
				if (!topicChoice) return { cancelled: true };
				topicSlug = topicChoice.slug;
				topicHeading = topicChoice.heading;
			} else {
				// remember tool path: use caller-supplied topic when present, else fall back to "general".
				const requested = topic?.trim();
				if (requested) {
					try {
						topicSlug = normalizeTopicInput(requested);
					} catch {
						return { error: `Invalid topic: ${requested}` };
					}
					topicHeading = slugToHeading(topicSlug);
				} else {
					topicSlug = "general";
					topicHeading = "General";
				}
			}

			if (scope === "agent") {
				for (const existing of loadAgentMemories(ctx)) {
					if (existing.topic === topicSlug && existing.title === displayTitle) removeAgentMemory(pi, ctx, existing);
				}
				saveAgentMemory(pi, ctx, { topic: topicSlug, title: displayTitle, content, tier });
			} else {
				await saveMemory(
					scope,
					scope === "project" ? currentProjectId : undefined,
					topicSlug,
					topicHeading,
					displayTitle,
					content,
					tier,
				);
			}

			return { topic: topicSlug, title: displayTitle, scope, tier };
		} catch (err: unknown) {
			return { error: `저장 실패: ${err instanceof Error ? err.message : "unknown"}` };
		}
	}

	// Command handlers are returned to index.ts, where lightweight command
	// proxies are registered synchronously for slash-command autocomplete.
	const onRememberCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		const raw = args.trim();
		if (!raw) {
			ctx.ui.notify("사용법: /remember [agent|user|project] [profile|log|note] <기억할 내용>", "warning");
			return;
		}
		const { scope, tier, content } = parseRememberArgs(raw);
		const result = await saveContent(content, undefined, scope, tier, ctx);
		if ("cancelled" in result) {
			ctx.ui.notify("기억 저장을 취소했습니다.", "info");
		} else if ("error" in result) {
			ctx.ui.notify(result.error, "error");
		} else {
			ctx.ui.notify(
				`📝 저장: "${result.title}" → ${result.topic}.md (scope: ${result.scope}, tier: ${result.tier}) — /memory에서 이동/정리 가능`,
				"info",
			);
		}
	};

	// ── /memory Command (Overlay UI) ──────────────────────────────────────

	const onMemoryCommand = async (args: string, ctx: ExtensionContext): Promise<void> => {
		currentProjectId = resolveCurrentProjectId(ctx.cwd);
		const filters = parseMemoryArgs(args);
		throwIfProjectScopeInvalid(currentProjectId, filters.scope, "browse");

		// Collect all entries for display
		const displayEntries = await collectDisplayEntries(currentProjectId, ctx);
		const filteredEntries = displayEntries.filter(
			(entry) => (!filters.scope || entry.scope === filters.scope) && (!filters.tier || entry.tier === filters.tier),
		);
		const visibleEntries = filters.search ? searchMemoryEntries(filteredEntries, filters.search) : filteredEntries;

		if (!ctx.hasUI) {
			if (!visibleEntries.length) {
				ctx.ui.notify("No memories stored.", "info");
				return;
			}
			for (const e of visibleEntries) {
				ctx.ui.notify(`[${e.scope}/${e.tier}] ${e.topic}/${e.title}`, "info");
			}
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			let selector: MemorySelectorComponent | null = null;
			let actionMenu: MemoryActionMenuComponent | null = null;
			let deleteConfirm: MemoryDeleteConfirmComponent | null = null;
			let activeComponent: {
				render: (width: number) => string[];
				invalidate: () => void;
				handleInput?: (data: string) => void;
				focused?: boolean;
			} | null = null;
			let wrapperFocused = false;

			const setActive = (
				c: {
					render: (w: number) => string[];
					invalidate: () => void;
					handleInput?: (data: string) => void;
					focused?: boolean;
				} | null,
			) => {
				if (activeComponent && "focused" in activeComponent) activeComponent.focused = false;
				activeComponent = c;
				if (activeComponent && "focused" in activeComponent) activeComponent.focused = wrapperFocused;
				tui.requestRender();
			};

			const refresh = async () => {
				const updated = await collectDisplayEntries(currentProjectId, ctx);
				selector?.setEntries(updated);
			};

			const deleteEntry = async (entry: SearchResult) => {
				try {
					await removeStoredMemory(pi, ctx, entry);
					ctx.ui.notify(`Deleted: "${entry.title}"`, "info");
				} catch (e) {
					ctx.ui.notify(`Error: ${e instanceof Error ? e.message : "unknown"}`, "error");
				}
				await refresh();
				setActive(selector);
			};

			const handleAction = async (entry: SearchResult, action: MemoryMenuAction) => {
				switch (action) {
					case "view":
						await openMemoryDetail(ctx, entry);
						if (actionMenu) setActive(actionMenu);
						return;
					case "viewTopic":
						await openMemoryTopicDetail(ctx, entry);
						if (actionMenu) setActive(actionMenu);
						return;
					case "copyContent":
						copyMemoryEntry(ctx, entry);
						setActive(selector);
						return;
					case "delete":
						deleteConfirm = new MemoryDeleteConfirmComponent(
							theme,
							`삭제하시겠습니까?\n[${entry.scope}] ${entry.topic} / "${entry.title}"`,
							(confirmed) => {
								if (!confirmed) {
									setActive(actionMenu);
									return;
								}
								void deleteEntry(entry);
							},
						);
						setActive(deleteConfirm);
						return;
				}
			};

			selector = new MemorySelectorComponent(
				tui,
				theme,
				displayEntries,
				(entry) => showActionMenu(entry),
				() => done(),
				filters.search,
				filters.scope,
				filters.tier,
			);
			setActive(selector);

			const showActionMenu = (entry: SearchResult) => {
				actionMenu = new MemoryActionMenuComponent(
					theme,
					entry,
					(action) => void handleAction(entry, action),
					() => setActive(selector),
				);
				setActive(actionMenu);
			};

			return {
				get focused() {
					return wrapperFocused;
				},
				set focused(value: boolean) {
					wrapperFocused = value;
					if (activeComponent && "focused" in activeComponent) activeComponent.focused = value;
				},
				render(width: number) {
					return activeComponent ? activeComponent.render(width) : [];
				},
				invalidate() {
					activeComponent?.invalidate();
				},
				handleInput(data: string) {
					activeComponent?.handleInput?.(data);
				},
			};
		});
	};

	// ── remember Tool (LLM-callable, fully non-interactive) ───────────────

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Save a fact, rule, or lesson to the user's long-term memory. " +
			"Call this when the user says '기억해', '앞으로 이렇게 해', '이 규칙 적용해', 'remember this', etc. " +
			"Choose a scope: 'agent' for the current Pi session only, 'user' for cross-project preferences, " +
			"or 'project' for repo-specific decisions. Choose a tier: profile (highest priority), log, or note. " +
			"Both default to project/profile for backward compatibility.",
		parameters: RememberParams,
		renderCall: renderRememberCall,
		renderResult: renderRememberResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { content, title, scope, tier, topic } = params as {
				content: string;
				title?: string;
				scope: MemoryScope;
				tier?: MemoryTier;
				topic?: string;
			};

			if (!content?.trim()) {
				throw new Error("content가 비어 있습니다.");
			}

			const result = await saveContent(content, title, scope, tier ?? "profile", ctx, false, topic);

			if ("cancelled" in result) {
				return { content: [{ type: "text" as const, text: "사용자가 기억 저장을 취소했습니다." }], details: undefined };
			}
			if ("error" in result) {
				throw new Error(result.error);
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Memory saved.\nScope: ${result.scope}\nTier: ${result.tier}\nTopic: ${result.topic}.md\nTitle: ${result.title}`,
					},
				],
				details: {
					kind: "remember" as const,
					scope: result.scope,
					tier: result.tier,
					topic: result.topic,
					title: result.title,
				},
			};
		},
	});

	// ── recall Tool ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search accessible user, project, and current-session memories. " +
			"Recall({ query }) returns matching summaries ordered profile, log, note. " +
			"Recall({ id }) returns one entry, while scope and tier filters apply to every mode.",
		parameters: RecallParams,
		renderCall: renderRecallCall,
		renderResult: renderRecallResult,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { query, id, scope, tier } = params as {
					query?: string;
					id?: string;
					scope?: MemoryScope;
					tier?: MemoryTier;
				};
				currentProjectId = resolveCurrentProjectId(ctx.cwd);
				throwIfProjectScopeInvalid(currentProjectId, scope, "recall");
				const entries = await collectDisplayEntries(currentProjectId, ctx);
				const filters = { scope, tier };
				if (id) return await executeRecallById(id, entries, filters);
				if (query) return executeRecallQuery(query, entries, filters);
				return executeRecallIndex(entries, filters);
			} catch (err: unknown) {
				throw new Error(`Recall failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
		},
	});

	// ── forget Tool ──────────────────────────────────────────────────────────

	pi.registerTool({
		name: "forget",
		label: "Forget",
		description:
			"Remove a memory from active recall by its ID from recall({ query }). " +
			"User/project entries are deleted from storage; agent entries are logically deleted and remain in session history. " +
			"Use when the user says '잊어줘', 'forget this', or a stored rule is no longer valid.",
		parameters: ForgetParams,
		renderCall: renderForgetCall,
		renderResult: renderForgetResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { id } = params as { id: string };
				if (!id?.trim()) throw new Error("forget requires a non-empty ID from recall.");
				currentProjectId = resolveCurrentProjectId(ctx.cwd);
				const entries = await collectDisplayEntries(currentProjectId, ctx);
				return await executeForgetById(id.trim(), entries, (entry) => removeStoredMemory(pi, ctx, entry));
			} catch (err: unknown) {
				throw new Error(`Forget failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
		},
	});

	// ── memory_list Tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description:
			"List accessible memories. Optionally filter by scope (agent, user, project) and tier (profile, log, note).",
		parameters: MemoryListParams,
		renderCall: renderMemoryListCall,
		renderResult: renderMemoryListResult,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { scope, tier } = params as { scope?: MemoryScope; tier?: MemoryTier };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);
				throwIfProjectScopeInvalid(currentProjectId, scope, "list");
				const entries = await collectDisplayEntries(currentProjectId, ctx);
				const filtered = entries.filter((entry) => (!scope || entry.scope === scope) && (!tier || entry.tier === tier));
				return {
					content: [{ type: "text" as const, text: formatMemoryIndex(filtered) || "No active memories." }],
					details: {
						kind: "memory-list" as const,
						scope,
						tier,
						agent: filtered.filter((entry) => entry.scope === "agent").length,
						user: filtered.filter((entry) => entry.scope === "user").length,
						project: filtered.filter((entry) => entry.scope === "project").length,
						topics: new Set(filtered.map((entry) => `${entry.scope}:${entry.topic}`)).size,
					},
				};
			} catch (err: unknown) {
				throw new Error(`List failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
		},
	});

	// ── Lifecycle Events ──────────────────────────────────────────────────

	const onSessionStart = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		try {
			await ensureDir();
			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			// One-time migration from JSON
			if (!migrationDone) {
				migrationDone = true;
				const { migrated, errors } = await migrateFromJson();
				if (migrated > 0) {
					ctx.ui.notify(`Memory: migrated ${migrated} entries to markdown.`, "info");
				}
				if (errors.length > 0) {
					ctx.ui.notify(`Memory migration errors: ${errors.join("; ")}`, "warning");
				}
			}
		} catch {
			// Graceful degradation
		}
	};

	// ── before_agent_start: Memory Injection ──────────────────────────────

	const onBeforeAgentStart = async (
		event: { systemPrompt: string },
		ctx: ExtensionContext,
	): Promise<{ systemPrompt: string } | undefined> => {
		try {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
			const hint = await buildMemoryPrompt(currentProjectId, loadAgentMemories(ctx));
			if (hint) {
				return { systemPrompt: event.systemPrompt + hint };
			}
		} catch {
			// Graceful degradation
		}
		return undefined;
	};

	return { onRememberCommand, onMemoryCommand, onSessionStart, onBeforeAgentStart };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function collectDisplayEntries(projectId: string | undefined, ctx: ExtensionContext): Promise<SearchResult[]> {
	return [...(await listPersistentMemories(projectId)), ...loadAgentMemories(ctx)];
}

async function removeStoredMemory(pi: ExtensionAPI, ctx: ExtensionContext, entry: SearchResult): Promise<void> {
	if (entry.scope === "agent") {
		removeAgentMemory(pi, ctx, entry);
		return;
	}
	const removed = await removeMemory(entry.scope, entry.projectId, entry.topic, entry.title, entry.content);
	if (!removed) throw new Error(`Memory not found: ${entry.topic} / "${entry.title}"`);
}
