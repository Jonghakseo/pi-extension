import fs from "node:fs";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const delayMs = Number.parseInt(process.env.MOCK_MCP_DELAY_MS ?? "0", 10);
const pidPath = process.env.MOCK_MCP_PID_PATH;
if (pidPath) fs.appendFileSync(pidPath, `${process.pid}\n`, "utf-8");
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

serveStdio(({ era }) => {
	const server = new McpServer({ name: "modern-stdio-test-server", version: "1.0.0" });
	server.registerTool(
		"echo",
		{
			description: "Echo through the negotiated protocol era",
			inputSchema: fromJsonSchema({
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			}),
		},
		async (args) => {
			const message = typeof args === "object" && args !== null && "message" in args ? String(args.message) : "";
			return { content: [{ type: "text", text: `${era}:${message}` }] };
		},
	);
	return server;
});
