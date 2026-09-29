import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatRecallOutput } from "../core/format-recall.ts";
import { getActiveLineageEntryIds } from "../core/lineage.ts";
import { filterLoadedByRole, loadAllMessages, withNonEmptySummary } from "../core/load-messages.ts";
import { parseRecallRole, parseRecallScope } from "../core/recall-scope.ts";
import { searchEntriesDetailed } from "../core/search-entries.ts";
import { RECALL_OUTPUT_CUSTOM_TYPE } from "../types.ts";

const PAGE_SIZE = 5;
const DEFAULT_RECENT = 25;
const COMMAND = "/pi-vcc-ko-recall";

export const registerVccRecallCommand = (pi: ExtensionAPI) => {
	pi.registerCommand("pi-vcc-ko-recall", {
		description:
			"Recall earlier parts of this session. Plain keywords work best; add scope:all to reach edited or retried turns, role:user to see only your own instructions.",
		handler: async (args: string, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("No session file available.", "error");
				return;
			}

			const raw = args.trim();
			const parsed = parseRecallScope(raw);
			const withRole = parseRecallRole(parsed.text);
			const role = withRole.role;
			const lineageEntryIds = parsed.scope === "lineage" ? getActiveLineageEntryIds(ctx.sessionManager) : undefined;
			const load = () =>
				filterLoadedByRole(loadAllMessages(sessionFile, false, lineageEntryIds, { includeCustom: true }), role);
			const sendRecent = () => {
				const recent = withNonEmptySummary(load().rendered).slice(-DEFAULT_RECENT);
				const output = (parsed.scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(recent);
				pi.sendMessage(
					{ customType: RECALL_OUTPUT_CUSTOM_TYPE, content: output, display: true },
					{ triggerTurn: true },
				);
			};
			if (!withRole.text) {
				// No query: show recent
				sendRecent();
				return;
			}

			// Parse page:N from args
			const pageMatch = withRole.text.match(/\bpage:(\d+)\b/i);
			const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
			const query = withRole.text.replace(/\bpage:\d+\b/i, "").trim();

			if (!query) {
				sendRecent();
				return;
			}

			const { rendered, rawMessages } = load();
			const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(rendered, rawMessages, query);
			// Single source of truth for page count: hits.length, the same array
			// that's actually paginated below (already floor-filtered and capped).
			const totalPages = Math.ceil(hits.length / PAGE_SIZE);
			const scopeSuffix = parsed.scope === "all" ? " (scope: all)" : "";
			const scopeArg = (parsed.scope === "all" ? " scope:all" : "") + (role ? ` role:${role}` : "");
			// The hard cap can discard genuine matches; hits.length alone would
			// then understate the real total. Say so explicitly instead of
			// reporting the capped count as if it were everything. Neutral
			// wording ("showing", not "showing top"): regex-path hits are
			// boolean/chronological matches with no relevance score, so "top"
			// would falsely imply a ranking that only the BM25 path has.
			const truncationNote = truncated
				? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
				: "";

			// The hard cap creates a fixed reachable page range (1..totalPages).
			// A page beyond it isn't "no matches" — matches exist, the page just
			// isn't reachable. Say so explicitly instead of falling through to
			// formatRecallOutput's zero-hit message, which would be false here.
			if (hits.length > 0 && page > totalPages) {
				// truncationNote already ends in "...refine your query" when the hard
				// cap kicked in — don't repeat that suggestion here, just say which
				// pages exist. Only add "or refine your query" when there's no
				// truncation note to have said it already.
				const guidance = truncated
					? `Use ${COMMAND} ${query}${scopeArg} page:N with N between 1 and ${totalPages}.`
					: `Use ${COMMAND} ${query}${scopeArg} page:N with N between 1 and ${totalPages}, or refine your query.`;
				const text =
					`Page ${page} is outside the available range 1-${totalPages} ` +
					`(${hits.length} matches${scopeSuffix}${truncationNote}). ${guidance}`;
				pi.sendMessage({ customType: RECALL_OUTPUT_CUSTOM_TYPE, content: text, display: true }, { triggerTurn: true });
				return;
			}

			const start = (page - 1) * PAGE_SIZE;
			const pageResults = hits.slice(start, start + PAGE_SIZE);
			const header =
				totalPages > 1
					? `Page ${page}/${totalPages} (${hits.length} total matches${scopeSuffix}${truncationNote})`
					: `${hits.length} matches${scopeSuffix}${truncationNote}`;
			const footer = page < totalPages ? `\n--- ${COMMAND} ${query}${scopeArg} page:${page + 1} ---` : "";
			const output = formatRecallOutput(pageResults, query, header) + footer;
			pi.sendMessage({ customType: RECALL_OUTPUT_CUSTOM_TYPE, content: output, display: true }, { triggerTurn: true });
		},
	});
};
