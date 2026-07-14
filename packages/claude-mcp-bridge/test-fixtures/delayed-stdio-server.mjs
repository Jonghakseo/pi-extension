import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const delayMs = Number.parseInt(process.env.MOCK_MCP_DELAY_MS ?? "3000", 10);
const server = new Server({ name: "delayed-stdio-test-server", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echo the provided message",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
	content: [{ type: "text", text: `pong:${String(request.params.arguments?.message ?? "")}` }],
}));

await new Promise((resolve) => setTimeout(resolve, delayMs));
await server.connect(new StdioServerTransport());
