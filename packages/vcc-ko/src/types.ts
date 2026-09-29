import type { Message } from "@earendil-works/pi-ai";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface FileOps {
	readFiles?: string[];
	modifiedFiles?: string[];
	createdFiles?: string[];
}

/**
 * Recall ref of the message a block came from: a session-global message index
 * (`#N`, number) or a custom_message ref such as `"c3"` (`#cN`). See
 * src/core/global-indices.ts. Undefined renders no ref (fail-closed).
 */
export type SourceRef = number | string;

export type NormalizedBlock =
	| { kind: "user"; text: string; sourceIndex?: SourceRef }
	| {
			kind: "custom";
			customType: string;
			text: string;
			/** Pi's display flag: false marks model-only context injected by an extension. */
			display?: boolean;
			sourceIndex?: SourceRef;
	  }
	| { kind: "assistant"; text: string; sourceIndex?: SourceRef }
	| {
			kind: "tool_call";
			name: string;
			args: Record<string, unknown>;
			/** Provider tool-call id, used to pair a call with its own result. */
			id?: string;
			sourceIndex?: SourceRef;
	  }
	| { kind: "tool_result"; name: string; text: string; toolCallId?: string; sourceIndex?: SourceRef }
	| {
			kind: "bash";
			command: string;
			output: string;
			exitCode: number | undefined;
			sourceIndex?: SourceRef;
	  };

/**
 * Session messages that pi persists but the pi-ai `Message` union does not
 * model (pi 0.87.x). Every normalizer/render path needs these two shapes,
 * so the narrow views live here instead of `as any` casts at each site.
 */
export type BashExecutionLike = {
	role: "bashExecution";
	command?: string;
	output?: string;
	exitCode?: number;
	excludeFromContext?: boolean;
};

export const asBashExecution = (msg: unknown): BashExecutionLike | null =>
	typeof msg === "object" && msg !== null && (msg as BashExecutionLike).role === "bashExecution"
		? (msg as BashExecutionLike)
		: null;

export type ToolCallPartLike = {
	type: "toolCall";
	name?: string;
	arguments?: unknown;
};

export const isToolCallPart = (part: unknown): part is ToolCallPartLike =>
	typeof part === "object" && part !== null && (part as ToolCallPartLike).type === "toolCall";

/**
 * customType of the `/pi-vcc-ko-recall` command's output message. Recall output
 * is never indexed by recall (a repeated query would match its own previous
 * output) and never summarized.
 */
export const RECALL_OUTPUT_CUSTOM_TYPE = "vcc-recall";

/** Preserve persisted roles; LLM transport conversion must not classify user intent. */
export type CompactionMessage =
	| Message
	| BashExecutionLike
	| { role: "custom"; customType: string; content: Message["content"]; display?: boolean }
	| { role: "branchSummary" | "compactionSummary"; summary: string };
