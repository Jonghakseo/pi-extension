import type { CompactionState } from "./core/summarize.ts";
import type { CompactionReason } from "./types.ts";

export interface PiVccCompactionDetails {
	compactor: "pi-vcc-ko";
	version: number;
	/** Header sections present in the summary, plus "Brief Transcript" when a brief exists. */
	sections: string[];
	sourceMessageCount: number;
	previousSummaryUsed: boolean;
	reason?: CompactionReason;
	willRetry?: boolean;
	/** Cumulative files and commits; the next compaction merges from this instead of parsing text. */
	state?: CompactionState;
}
