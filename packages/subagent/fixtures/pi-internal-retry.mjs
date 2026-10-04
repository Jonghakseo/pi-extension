import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const persist = (entry) => appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
const assistant = (stopReason, text, errorMessage) => ({
	role: "assistant",
	api: "anthropic-messages",
	provider: "anthropic",
	model: "fake-model",
	content: text ? [{ type: "text", text }] : [],
	stopReason,
	errorMessage,
	timestamp: Date.now(),
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
});

// Raw history retains the failed response, even though model projection omits it.
const error = assistant("error", "", "Connection error.");
emit({ type: "agent_start" });
emit({ type: "message_end", message: error });
persist({ type: "message", id: "error-1", message: error, timestamp: new Date().toISOString() });
emit({ type: "agent_end", messages: [error], willRetry: true });
emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 15, delayMs: 3200, errorMessage: error.errorMessage });
persist({ type: "context_edit", id: "omit-1", targetId: "error-1", replacement: null });
await sleep(3200);

if (readFileSync(sessionFile, "utf8").includes('"type":"subagent_done"')) {
	process.stderr.write("premature completion marker during Pi backoff\n");
	process.exitCode = 1;
} else {
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	const success = assistant("stop", "Recovered in the same child");
	emit({ type: "message_end", message: success });
	persist({ type: "message", id: "success-1", message: success, timestamp: new Date().toISOString() });
	emit({ type: "auto_retry_end", success: true, attempt: 1 });
	emit({ type: "agent_end", messages: [success], willRetry: false });
}
