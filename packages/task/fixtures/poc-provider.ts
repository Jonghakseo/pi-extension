import { writeFileSync } from "node:fs";
import { type AssistantMessage, createAssistantMessageEventStream, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic offline model. The RPC sessions, tools, evaluator and shell jobs remain real. */
export default function pocProvider(pi: ExtensionAPI): void {
	let started = false;
	let reportSent = false;
	pi.registerProvider("task-poc", {
		api: "task-poc-api",
		apiKey: "offline-fixture-not-a-secret",
		baseUrl: "http://127.0.0.1:1",
		models: ["parent", "evaluator", "worker-a", "worker-b"].map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100000,
			maxTokens: 1000,
		})),
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const textOf = (content: unknown): string =>
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.flatMap((p) => (p?.type === "text" ? [p.text] : [])).join("\n")
						: "";
			const users = context.messages.filter((m) => m.role === "user");
			const user = [...users]
				.reverse()
				.find((m) => !textOf(m.content).startsWith("Still running or awaiting delivery"));
			const input = user ? textOf(user.content) : "";
			const last = context.messages.at(-1);
			const text = (value: string) => {
				message.content = [{ type: "text", text: value }];
			};
			const tool = (name: string, args: JsonObject) => {
				message.content = [{ type: "toolCall", id: `poc-${Date.now()}-${name}`, name, arguments: args }];
				message.stopReason = "toolUse";
			};
			if (model.id === "evaluator") {
				text(JSON.stringify({ tier: input.includes("email-only") ? "balanced" : "fast" }));
			} else if (model.id === "parent") {
				if (last?.role === "toolResult") text("CONTROL_ACCEPTED");
				else if (input.startsWith("run-poc"))
					tool("Task", {
						task: "Run the finite asynchronous PoC command, inspect its result, then report.",
						readonly: true,
					});
				else if (input.startsWith("edit-poc "))
					tool("Task", {
						action: "edit",
						taskId: input.trim().split(/\s+/)[1],
						task: "email-only: preserve the running command and report its actual output.",
					});
				else if (input.includes("[Task ") && input.includes("ASYNC_POC_DONE")) text("PARENT_REPORT_PROCESSED");
				else text("PARENT_IDLE");
			} else {
				const root = process.env.TASK_POC_ROOT;
				if (!root) throw new Error("TASK_POC_ROOT is required for the offline fixture");
				const transcript = users.map((m) => textOf(m.content)).join("\n");
				const revisions = [...transcript.matchAll(/Task task-[a-f0-9-]+, revision (\d+)/g)].map((m) => Number(m[1]));
				const revision = Math.max(1, ...revisions);
				if (!started) {
					started = true;
					const code = `require('node:fs').writeFileSync(${JSON.stringify(`${root}/job-ready.json`)},JSON.stringify({pid:process.pid}));setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(`${root}/job-done`)},'done');console.log('ASYNC_POC_DONE')},5000)`;
					const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
					tool("bash_async", {
						action: "start",
						command: `${quote(process.execPath)} -e ${quote(code)}`,
						title: "Task RPC PoC",
						timeout: 30,
					});
				} else if (input.includes("ASYNC_POC_DONE") && input.includes("succeeded (exit 0)") && !reportSent) {
					reportSent = true;
					tool("task_report", {
						revision,
						status: "success",
						summary: "ASYNC_POC_DONE observed after edit",
						artifacts: [],
						verification: ["The original detached job completed after revision changed."],
						blockers: [],
					});
				} else {
					if (revision === 2)
						writeFileSync(`${root}/edit-observed.json`, JSON.stringify({ revision, model: model.id }));
					text("WAITING_FOR_BACKGROUND_COMPLETION");
				}
			}
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
			stream.end();
			return stream;
		},
	});
}
