import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const controlPath = process.env.MOCK_MCP_CONTROL_PATH;
if (!controlPath) throw new Error("MOCK_MCP_CONTROL_PATH is required");
const server = new Server({ name: "paused-stdio-test-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [{ name: "record", inputSchema: { type: "object", properties: { body: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
	fs.writeFileSync(`${controlPath}.received`, String(request.params.arguments?.body?.length ?? 0));
	return { content: [{ type: "text", text: "received" }] };
});

await server.connect(new StdioServerTransport());
const poll = setInterval(() => {
	if (!fs.existsSync(`${controlPath}.pause`)) return;
	clearInterval(poll);
	process.stdin.pause();
	fs.writeFileSync(`${controlPath}.paused`, "ready");
	setTimeout(() => process.stdin.resume(), Number(process.env.MOCK_MCP_RESUME_MS ?? "500"));
}, 10);
