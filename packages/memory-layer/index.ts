import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { copyToClipboard } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

import { buildMemoryPrompt } from "./inject.ts";
import { resolveProjectId } from "./project-id.ts";
import {
	ensureDir,
	findMemoryById,
	listTopics,
	loadTopicEntries,
	memoryEntryId,
	memoryExistsInScope,
	migrateFromJson,
	readMemoryMd,
	readTopicFile,
	removeMemory,
	type SearchResult,
	sanitizeTopic,
	saveMemory,
	searchMemories,
} from "./storage.ts";
import type { MemoryScope } from "./types.ts";
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
	return `${firstLine.slice(0, maxLen - 1)}…`;
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
	const existing = await listTopics(scope, projectId);
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

function parseRememberArgs(raw: string): { scope: MemoryScope; content: string } {
	const scopeMatch = raw.match(/^(user|project)\s+([\s\S]+)$/);
	if (scopeMatch) {
		return { scope: scopeMatch[1] as MemoryScope, content: scopeMatch[2].trim() };
	}
	return { scope: "project", content: raw };
}

function buildTextResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

async function openMemoryDetail(ctx: ExtensionContext, entry: SearchResult): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new MemoryDetailOverlayComponent(tui, theme, entry, () => done()),
		{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
	);
}

async function openMemoryTopicDetail(ctx: ExtensionContext, entry: SearchResult): Promise<void> {
	const fullTopic = await readTopicFile(entry.scope, entry.projectId, entry.topic);
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

async function executeRecallById(id: string, projectId: string | undefined) {
	const entry = await findMemoryById(id, projectId);
	if (!entry) {
		throw new Error(`Memory not found with id: ${id}`);
	}
	return buildTextResult(`[${entry.scope}] ${entry.topic}/${entry.title}\n\n${entry.content}`);
}

async function executeRecallQuery(query: string, projectId: string | undefined, scope?: MemoryScope) {
	let results = await searchMemories(query, projectId);
	if (scope) {
		results = results.filter((r) => r.scope === scope);
	}
	if (results.length === 0) {
		return buildTextResult("No matching memories found.");
	}
	const maxResults = 20;
	const lines = results.slice(0, maxResults).map((r) => {
		const id = memoryEntryId(r.scope, r.projectId, r.topic, r.title, r.content);
		const firstLine = r.content.split("\n")[0] ?? "";
		const snippet = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
		return `- [${id}] [${r.scope}] ${r.topic}/${r.title}${snippet ? `\n  ${snippet}` : ""}`;
	});
	const shown = Math.min(results.length, maxResults);
	const header =
		results.length > shown
			? `Found ${results.length} memories (showing top ${shown}):`
			: `Found ${results.length} memories:`;
	return buildTextResult(`${header}\n\n${lines.join("\n")}\n\nUse recall with id to view full content.`);
}

async function executeRecallIndex(projectId: string | undefined, scope?: MemoryScope) {
	const parts: string[] = [];
	if (!scope || scope === "user") {
		const userIndex = (await readMemoryMd("user")).trim();
		if (userIndex) parts.push(userIndex);
	}
	if ((!scope || scope === "project") && projectId) {
		const projectIndex = (await readMemoryMd("project", projectId)).trim();
		if (projectIndex) parts.push(projectIndex);
	}
	return buildTextResult(parts.filter(Boolean).join("\n\n") || "No memories stored.");
}

function normalizeForgetTitle(title: string) {
	const normalizedTitle = title?.trim();
	return normalizedTitle ? normalizedTitle : null;
}

async function executeForgetTopic(
	topic: string,
	normalizedTitle: string,
	scope: MemoryScope | undefined,
	currentProjectId: string | undefined,
) {
	let normalizedTopic: string;
	try {
		normalizedTopic = normalizeTopicInput(topic);
	} catch {
		throw new Error(`Invalid topic: ${topic}`);
	}

	if (scope) {
		const pid = scope === "project" ? currentProjectId : undefined;
		const removed = await removeMemory(scope, pid, normalizedTopic, normalizedTitle);
		if (!removed) {
			throw new Error(`Memory not found in ${scope} scope: ${normalizedTopic} / "${normalizedTitle}"`);
		}
		return buildTextResult(`Deleted from ${scope}: ${normalizedTopic} / "${normalizedTitle}"`);
	}

	const existsInUser = await memoryExistsInScope("user", undefined, normalizedTopic, normalizedTitle);
	const existsInProject = currentProjectId
		? await memoryExistsInScope("project", currentProjectId, normalizedTopic, normalizedTitle)
		: false;

	if (existsInUser && existsInProject) {
		throw new Error(
			`Ambiguous: "${normalizedTitle}" exists in both user and project scopes for topic "${normalizedTopic}". Specify scope parameter: scope="user" or scope="project" to resolve.`,
		);
	}
	if (!existsInUser && !existsInProject) {
		throw new Error(`Memory not found: ${normalizedTopic} / "${normalizedTitle}"`);
	}

	const targetScope: MemoryScope = existsInUser ? "user" : "project";
	const pid = targetScope === "project" ? currentProjectId : undefined;
	const removed = await removeMemory(targetScope, pid, normalizedTopic, normalizedTitle);
	if (!removed) {
		throw new Error(`Memory not found: ${normalizedTopic} / "${normalizedTitle}"`);
	}
	return buildTextResult(`Deleted from ${targetScope}: ${normalizedTopic} / "${normalizedTitle}"`);
}

async function executeForgetByTitle(
	normalizedTitle: string,
	scope: MemoryScope | undefined,
	currentProjectId: string | undefined,
) {
	const entries = await collectDisplayEntries(currentProjectId);
	const scopedEntries = scope ? entries.filter((entry) => entry.scope === scope) : entries;

	let matches = scopedEntries.filter((entry) => entry.title === normalizedTitle);
	let caseInsensitive = false;
	if (matches.length === 0) {
		const lower = normalizedTitle.toLowerCase();
		matches = scopedEntries.filter((entry) => entry.title.toLowerCase() === lower);
		caseInsensitive = matches.length > 0;
	}

	if (matches.length === 0) {
		throw new Error(
			`Memory not found by title: "${normalizedTitle}".\nTip: provide topic as well (e.g. topic: 'general' or 'general.md') for precise deletion.`,
		);
	}
	if (matches.length > 1) {
		const preview = matches
			.slice(0, 6)
			.map((entry) => `- [${entry.scope}] ${entry.topic} / "${entry.title}"`)
			.join("\n");
		const more = matches.length > 6 ? `\n... and ${matches.length - 6} more` : "";
		throw new Error(
			`Ambiguous title: "${normalizedTitle}" matches ${matches.length} memories.\nSpecify topic (and scope if needed) to delete safely.\n\n${preview}${more}`,
		);
	}

	const target = matches[0];
	const removed = await removeMemory(target.scope, target.projectId, target.topic, target.title);
	if (!removed) {
		throw new Error(`Memory not found: ${target.topic} / "${target.title}"`);
	}
	const caseMatchNote = caseInsensitive ? ` (matched title: "${target.title}")` : "";
	return buildTextResult(`Deleted from ${target.scope}: ${target.topic} / "${target.title}"${caseMatchNote}`);
}

// ── Extension Entry Point ────────────────────────────────────────────────────

export default function memoryLayerExtension(pi: ExtensionAPI) {
	let currentProjectId: string | undefined;
	let migrationDone = false;

	/**
	 * Core save logic shared by /remember command and remember tool.
	 *
	 * @param scope - Explicit storage scope ("user" | "project").
	 * @param interactive - If true (default), prompts for topic selection.
	 *   If false, auto-selects "general" topic with no UI prompts.
	 */
	async function saveContent(
		content: string,
		title: string | undefined,
		scope: MemoryScope,
		ctx: ExtensionContext,
		interactive = true,
	): Promise<{ topic: string; title: string; scope: MemoryScope } | { cancelled: true } | { error: string }> {
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
				// remember tool path: auto-select "general" — NO UI prompts
				topicSlug = "general";
				topicHeading = "General";
			}

			await saveMemory(
				scope,
				scope === "project" ? currentProjectId : undefined,
				topicSlug,
				topicHeading,
				displayTitle,
				content,
			);

			return { topic: topicSlug, title: displayTitle, scope };
		} catch (err: unknown) {
			return { error: `저장 실패: ${err instanceof Error ? err.message : "unknown"}` };
		}
	}

	// ── /remember Command ─────────────────────────────────────────────────

	pi.registerCommand("remember", {
		description: "Store a memory. Usage: /remember [user|project] <content>",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (!raw) {
				ctx.ui.notify("사용법: /remember [user|project] <기억할 내용>", "warning");
				return;
			}
			const { scope, content } = parseRememberArgs(raw);
			const result = await saveContent(content, undefined, scope, ctx);
			if ("cancelled" in result) {
				ctx.ui.notify("기억 저장을 취소했습니다.", "info");
			} else if ("error" in result) {
				ctx.ui.notify(result.error, "error");
			} else {
				ctx.ui.notify(
					`📝 저장: "${result.title}" → ${result.topic}.md (scope: ${result.scope}) — /memory에서 이동/정리 가능`,
					"info",
				);
			}
		},
	});

	// ── /memory Command (Overlay UI) ──────────────────────────────────────

	pi.registerCommand("memory", {
		description: "Browse and manage stored memories",
		handler: async (args, ctx) => {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);

			// Collect all entries for display
			const displayEntries = await collectDisplayEntries(currentProjectId);

			if (!ctx.hasUI) {
				if (!displayEntries.length) {
					ctx.ui.notify("No memories stored.", "info");
					return;
				}
				for (const e of displayEntries) {
					ctx.ui.notify(`[${e.scope}] ${e.topic}/${e.title}`, "info");
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
					const updated = await collectDisplayEntries(currentProjectId);
					selector?.setEntries(updated);
				};

				const deleteEntry = async (entry: SearchResult) => {
					try {
						const ok = await removeMemory(entry.scope, entry.projectId, entry.topic, entry.title);
						ctx.ui.notify(ok ? `Deleted: "${entry.title}"` : "Not found", ok ? "info" : "error");
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
					(args ?? "").trim() || undefined,
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
		},
	});

	// ── remember Tool (LLM-callable, fully non-interactive) ───────────────

	pi.registerTool({
		name: "remember",
		label: "Remember",
		description:
			"Save a fact, rule, or lesson to the user's long-term memory. " +
			"Call this when the user says '기억해', '앞으로 이렇게 해', '이 규칙 적용해', 'remember this', etc. " +
			"You must choose the appropriate scope: " +
			"'user' for personal profile, global preferences, or cross-project rules; " +
			"'project' for repo-specific tech decisions, env, tooling, configs. " +
			"Defaults to 'project' when ambiguous.",
		parameters: RememberParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { content, title, scope } = params as { content: string; title?: string; scope: MemoryScope };

			if (!content?.trim()) {
				throw new Error("content가 비어 있습니다.");
			}

			const result = await saveContent(content, title, scope, ctx, false);

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
						text: `Memory saved.\nScope: ${result.scope}\nTopic: ${result.topic}.md\nTitle: ${result.title}`,
					},
				],
				details: undefined,
			};
		},
	});

	// ── recall Tool ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Search the user's long-term memory for relevant information. " +
			"Use this when you need to check if there are stored rules, preferences, or lessons " +
			"related to the current task. " +
			"Three usage patterns: recall({ query }) to search and get a summary list with IDs, " +
			"recall({ id }) to get the full content of a specific memory, " +
			"or recall({ scope }) to list all memories filtered by scope.",
		parameters: RecallParams,

		renderCall(args, theme) {
			const query = typeof args.query === "string" ? args.query : undefined;
			const id = typeof args.id === "string" ? args.id : undefined;
			const scope = typeof args.scope === "string" ? args.scope : undefined;
			let text = theme.fg("toolTitle", theme.bold("recall"));
			if (id) text += ` ${theme.fg("accent", `id:${id}`)}`;
			if (query) text += ` ${theme.fg("accent", `"${query}"`)}`;
			if (scope) text += ` ${theme.fg("accent", `scope:${scope}`)}`;
			if (!query && !id) text += ` ${theme.fg("muted", "(index)")}`;
			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { query, id, scope } = params as { query?: string; id?: string; scope?: MemoryScope };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				throwIfProjectScopeInvalid(currentProjectId, scope, "recall");
				if (id) return await executeRecallById(id, currentProjectId);
				if (query) return await executeRecallQuery(query, currentProjectId, scope);
				return await executeRecallIndex(currentProjectId, scope);
			} catch (err: unknown) {
				throw new Error(`Recall failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
		},
	});

	// ── P2-2: forget Tool (scope ambiguity check) ─────────────────────────

	pi.registerTool({
		name: "forget",
		label: "Forget",
		description:
			"Permanently delete a memory. This action is irreversible. " +
			"Use when the user says '잊어줘', 'forget this', or a stored rule is no longer valid. " +
			"Provide title and optional topic/scope; if topic is omitted, the title must resolve uniquely.",
		parameters: ForgetParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { topic, title, scope } = params as { topic?: string; title: string; scope?: MemoryScope };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				throwIfProjectScopeInvalid(currentProjectId, scope, "forget");

				const normalizedTitle = normalizeForgetTitle(title);
				if (!normalizedTitle) {
					throw new Error("forget requires non-empty title.");
				}

				if (topic) {
					return await executeForgetTopic(topic, normalizedTitle, scope, currentProjectId);
				}
				return await executeForgetByTitle(normalizedTitle, scope, currentProjectId);
			} catch (err: unknown) {
				throw new Error(`Forget failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
		},
	});

	// ── memory_list Tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List all active memories. Optionally filter by scope (user or project).",
		parameters: MemoryListParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const { scope } = params as { scope?: MemoryScope };
				currentProjectId = resolveCurrentProjectId(ctx.cwd);

				const parts: string[] = [];

				if (!scope || scope === "user") {
					const idx = (await readMemoryMd("user")).trim();
					if (idx) {
						parts.push("[User Memory]");
						parts.push(idx);
					}
				}

				if ((!scope || scope === "project") && currentProjectId) {
					const idx = (await readMemoryMd("project", currentProjectId)).trim();
					if (idx) {
						if (parts.length) parts.push("");
						parts.push("[Project Memory]");
						parts.push(idx);
					}
				}

				const text = parts.join("\n") || "No active memories.";
				return { content: [{ type: "text" as const, text }], details: undefined };
			} catch (err: unknown) {
				throw new Error(`List failed: ${err instanceof Error ? err.message : "unknown"}`);
			}
		},
	});

	// ── Lifecycle Events ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
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
	});

	// ── before_agent_start: Memory Injection ──────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			currentProjectId = resolveCurrentProjectId(ctx.cwd);
			const hint = await buildMemoryPrompt(currentProjectId);
			if (hint) {
				return { systemPrompt: event.systemPrompt + hint };
			}
		} catch {
			// Graceful degradation
		}
		return undefined;
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function collectDisplayEntries(projectId?: string): Promise<SearchResult[]> {
	const results: SearchResult[] = [];
	const scopes: Array<{ scope: MemoryScope; pid?: string }> = [
		{ scope: "user" },
		...(projectId ? [{ scope: "project" as MemoryScope, pid: projectId }] : []),
	];
	for (const { scope, pid } of scopes) {
		const topics = await listTopics(scope, pid);
		for (const topic of topics) {
			const entries = await loadTopicEntries(scope, pid, topic);
			for (const entry of entries) {
				results.push({ scope, projectId: pid, topic, title: entry.title, content: entry.content });
			}
		}
	}
	return results;
}
