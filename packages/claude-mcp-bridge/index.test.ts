import { describe, expect, it } from "vitest";
import {
	buildPiToolName,
	buildToolVisibilityKey,
	createParameterSchema,
	expandEnvVars,
	extractRawServers,
	formatToolResult,
	mimeToExt,
	normalizeServer,
	parseDisabledToolKeys,
	parseToolVisibilityKey,
	sanitizeName,
	serializeToolVisibilitySettings,
	TOOL_VISIBILITY_KEY_SEPARATOR,
} from "./index.ts";

function envRef(name: string): string {
	return `\${${name}}`;
}

// ---------------------------------------------------------------------------
// sanitizeName — slug sanitization
// ---------------------------------------------------------------------------

describe("sanitizeName", () => {
	it("should lowercase and replace non-alphanumeric chars with underscores", () => {
		expect(sanitizeName("My-Server.Name")).toBe("my_server_name");
	});

	it("should strip leading and trailing underscores", () => {
		expect(sanitizeName("__hello__")).toBe("hello");
	});

	it("should collapse consecutive special characters into single underscore", () => {
		expect(sanitizeName("a---b...c")).toBe("a_b_c");
	});

	it("should truncate to 80 characters", () => {
		const long = "a".repeat(100);
		expect(sanitizeName(long).length).toBe(80);
	});

	it("should return empty string for empty input", () => {
		expect(sanitizeName("")).toBe("");
	});

	it("should return empty string for all-special-char input", () => {
		expect(sanitizeName("---")).toBe("");
	});

	it("should preserve underscores and digits", () => {
		expect(sanitizeName("my_server_2")).toBe("my_server_2");
	});
});

// ---------------------------------------------------------------------------
// buildPiToolName — sanitized tool name generation
// ---------------------------------------------------------------------------

describe("buildPiToolName", () => {
	it("should combine server and tool names with mcp_ prefix", () => {
		expect(buildPiToolName("my-server", "read_file")).toBe("mcp_my_server_read_file");
	});

	it("should sanitize both names", () => {
		expect(buildPiToolName("My Server!", "Get-Data")).toBe("mcp_my_server_get_data");
	});

	it("should fall back to 'server' for empty server name", () => {
		expect(buildPiToolName("", "read")).toBe("mcp_server_read");
	});

	it("should fall back to 'tool' for empty tool name", () => {
		expect(buildPiToolName("myserver", "")).toBe("mcp_myserver_tool");
	});

	it("should fall back to both defaults for all-special-chars", () => {
		expect(buildPiToolName("---", "!!!")).toBe("mcp_server_tool");
	});
});

// ---------------------------------------------------------------------------
// extractRawServers — config object parsing
// ---------------------------------------------------------------------------

describe("extractRawServers", () => {
	it("should extract from mcpServers key", () => {
		const data = { mcpServers: { fs: { command: "node", args: ["fs.js"] } } };
		const result = extractRawServers(data);
		expect(result).toEqual({ fs: { command: "node", args: ["fs.js"] } });
	});

	it("should extract from mcp.servers key", () => {
		const data = { mcp: { servers: { fs: { command: "node" } } } };
		const result = extractRawServers(data);
		expect(result).toEqual({ fs: { command: "node" } });
	});

	it("should extract from servers key", () => {
		const data = { servers: { fs: { command: "node" } } };
		const result = extractRawServers(data);
		expect(result).toEqual({ fs: { command: "node" } });
	});

	it("should prefer mcpServers over mcp.servers", () => {
		const data = {
			mcpServers: { preferred: { command: "a" } },
			mcp: { servers: { fallback: { command: "b" } } },
		};
		const result = extractRawServers(data);
		expect(result).toHaveProperty("preferred");
		expect(result).not.toHaveProperty("fallback");
	});

	it("should return null for null/undefined input", () => {
		expect(extractRawServers(null)).toBeNull();
		expect(extractRawServers(undefined)).toBeNull();
	});

	it("should return null for non-object input", () => {
		expect(extractRawServers("string")).toBeNull();
		expect(extractRawServers(42)).toBeNull();
	});

	it("should return null for empty object with no server keys", () => {
		expect(extractRawServers({})).toBeNull();
		expect(extractRawServers({ unrelated: "data" })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// normalizeServer — server config normalization
// ---------------------------------------------------------------------------

describe("normalizeServer", () => {
	it("should return null for disabled servers", () => {
		expect(normalizeServer("test", { enabled: false, command: "node" })).toBeNull();
	});

	it("should detect stdio type from command field", () => {
		const result = normalizeServer("test", { command: "npx", args: ["-y", "server"] });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("stdio");
		expect(result?.name).toBe("test");
		if (result?.type === "stdio") {
			expect(result.command).toBe("npx");
			expect(result.args).toEqual(["-y", "server"]);
		}
	});

	it("should detect stdio type from explicit type field", () => {
		const result = normalizeServer("test", { type: "stdio", command: "node" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("stdio");
	});

	it("should return null for stdio type without command", () => {
		expect(normalizeServer("test", { type: "stdio" })).toBeNull();
	});

	it("should default args to empty array if not provided", () => {
		const result = normalizeServer("test", { command: "node" });
		expect(result).not.toBeNull();
		if (result?.type === "stdio") {
			expect(result.args).toEqual([]);
		}
	});

	it("should detect SSE type from url with /sse path", () => {
		const result = normalizeServer("test", { url: "http://localhost:3000/sse" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("sse");
	});

	it("should detect SSE type from url with /sse/ trailing slash", () => {
		const result = normalizeServer("test", { url: "http://localhost:3000/sse/" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("sse");
	});

	it("should detect SSE type from url with /sse?query", () => {
		const result = normalizeServer("test", { url: "http://localhost:3000/sse?token=abc" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("sse");
	});

	it("should default to HTTP for non-SSE urls", () => {
		const result = normalizeServer("test", { url: "http://localhost:3000/mcp" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("http");
	});

	it("should respect explicit type override for sse", () => {
		const result = normalizeServer("test", { type: "sse", url: "http://localhost:3000/mcp" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("sse");
	});

	it("should respect explicit type override for http", () => {
		const result = normalizeServer("test", { type: "http", url: "http://localhost:3000/sse" });
		expect(result).not.toBeNull();
		expect(result?.type).toBe("http");
	});

	it("should expand env vars in command", () => {
		const original = process.env.TEST_MCP_CMD;
		process.env.TEST_MCP_CMD = "/usr/local/bin/node";
		try {
			const result = normalizeServer("test", { command: envRef("TEST_MCP_CMD") });
			expect(result).not.toBeNull();
			if (result?.type === "stdio") {
				expect(result.command).toBe("/usr/local/bin/node");
			}
		} finally {
			if (original === undefined) delete process.env.TEST_MCP_CMD;
			else process.env.TEST_MCP_CMD = original;
		}
	});

	it("should expand env vars in url", () => {
		const original = process.env.TEST_MCP_HOST;
		process.env.TEST_MCP_HOST = "localhost:3000";
		try {
			const result = normalizeServer("test", { url: `http://${envRef("TEST_MCP_HOST")}/mcp` });
			expect(result).not.toBeNull();
			if (result?.type === "sse" || result?.type === "http") {
				expect(result.url).toBe("http://localhost:3000/mcp");
			}
		} finally {
			if (original === undefined) delete process.env.TEST_MCP_HOST;
			else process.env.TEST_MCP_HOST = original;
		}
	});

	it("should expand env vars in args", () => {
		const original = process.env.TEST_MCP_ARG;
		process.env.TEST_MCP_ARG = "expanded";
		try {
			const result = normalizeServer("test", { command: "node", args: [`--flag=${envRef("TEST_MCP_ARG")}`] });
			expect(result).not.toBeNull();
			if (result?.type === "stdio") {
				expect(result.args).toEqual(["--flag=expanded"]);
			}
		} finally {
			if (original === undefined) delete process.env.TEST_MCP_ARG;
			else process.env.TEST_MCP_ARG = original;
		}
	});

	it("should merge process env with custom env for stdio", () => {
		const result = normalizeServer("test", {
			command: "node",
			env: { CUSTOM_VAR: "custom_value" },
		});
		expect(result).not.toBeNull();
		if (result?.type === "stdio") {
			expect(result.env.CUSTOM_VAR).toBe("custom_value");
			expect(result.env.PATH).toBeDefined();
		}
	});

	it("should expand env vars in headers", () => {
		const original = process.env.TEST_MCP_TOKEN;
		process.env.TEST_MCP_TOKEN = "bearer_abc";
		try {
			const result = normalizeServer("test", {
				url: "http://localhost:3000/mcp",
				headers: { Authorization: envRef("TEST_MCP_TOKEN") },
			});
			expect(result).not.toBeNull();
			if (result?.type === "sse" || result?.type === "http") {
				expect(result.headers.Authorization).toBe("bearer_abc");
			}
		} finally {
			if (original === undefined) delete process.env.TEST_MCP_TOKEN;
			else process.env.TEST_MCP_TOKEN = original;
		}
	});

	it("should return null when neither command nor url is provided", () => {
		expect(normalizeServer("test", {})).toBeNull();
	});

	it("should handle cwd for stdio servers", () => {
		const result = normalizeServer("test", { command: "node", cwd: "/tmp/test" });
		expect(result).not.toBeNull();
		if (result?.type === "stdio") {
			expect(result.cwd).toBe("/tmp/test");
		}
	});

	it("should set enabled to true for active servers", () => {
		const result = normalizeServer("test", { command: "node" });
		expect(result).not.toBeNull();
		expect(result?.enabled).toBe(true);
	});

	it("should default headers to empty object for url-based servers", () => {
		const result = normalizeServer("test", { url: "http://localhost:3000/mcp" });
		expect(result).not.toBeNull();
		if (result?.type === "sse" || result?.type === "http") {
			expect(result.headers).toEqual({});
		}
	});
});

// ---------------------------------------------------------------------------
// expandEnvVars — environment variable expansion
// ---------------------------------------------------------------------------

describe("expandEnvVars", () => {
	it("should expand env var references", () => {
		const original = process.env.TEST_EXPAND_VAR;
		process.env.TEST_EXPAND_VAR = "hello";
		try {
			expect(expandEnvVars(`${envRef("TEST_EXPAND_VAR")} world`)).toBe("hello world");
		} finally {
			if (original === undefined) delete process.env.TEST_EXPAND_VAR;
			else process.env.TEST_EXPAND_VAR = original;
		}
	});

	it("should replace missing vars with empty string", () => {
		delete process.env.__NONEXISTENT_MCP_VAR__;
		expect(expandEnvVars(envRef("__NONEXISTENT_MCP_VAR__"))).toBe("");
	});

	it("should handle multiple vars in one string", () => {
		const origA = process.env.TEST_EA;
		const origB = process.env.TEST_EB;
		process.env.TEST_EA = "foo";
		process.env.TEST_EB = "bar";
		try {
			expect(expandEnvVars(`${envRef("TEST_EA")}/${envRef("TEST_EB")}`)).toBe("foo/bar");
		} finally {
			if (origA === undefined) delete process.env.TEST_EA;
			else process.env.TEST_EA = origA;
			if (origB === undefined) delete process.env.TEST_EB;
			else process.env.TEST_EB = origB;
		}
	});

	it("should return string unchanged if no vars present", () => {
		expect(expandEnvVars("no vars here")).toBe("no vars here");
	});

	it("should return empty string for empty input", () => {
		expect(expandEnvVars("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// formatToolResult — result formatting
// ---------------------------------------------------------------------------

describe("formatToolResult", () => {
	it("should return string result directly", () => {
		const result = formatToolResult("hello world");
		expect(result.text).toBe("hello world");
		expect(result.imagePaths).toEqual([]);
	});

	it("should extract text from content array", () => {
		const result = formatToolResult({
			content: [
				{ type: "text", text: "line 1" },
				{ type: "text", text: "line 2" },
			],
		});
		expect(result.text).toBe("line 1\nline 2");
		expect(result.imagePaths).toEqual([]);
	});

	it("should fall back to JSON when text items produce empty strings", () => {
		const input = { content: [{ type: "text" }] };
		const result = formatToolResult(input);
		expect(result.text).toBe(JSON.stringify(input, null, 2));
	});

	it("should JSON.stringify structuredContent", () => {
		const data = { key: "value", nested: { a: 1 } };
		const result = formatToolResult({ structuredContent: data });
		expect(result.text).toBe(JSON.stringify(data, null, 2));
		expect(result.imagePaths).toEqual([]);
	});

	it("should JSON.stringify non-content objects as fallback", () => {
		const obj = { some: "data" };
		const result = formatToolResult(obj);
		expect(result.text).toBe(JSON.stringify(obj, null, 2));
	});

	it("should JSON.stringify object when content array is empty", () => {
		const input = { content: [] };
		const result = formatToolResult(input);
		expect(result.text).toBe(JSON.stringify(input, null, 2));
	});

	it("should handle mixed content types (text + non-text)", () => {
		const result = formatToolResult({
			content: [
				{ type: "text", text: "hello" },
				{ type: "resource", uri: "file://test" },
			],
		});
		expect(result.text).toContain("hello");
	});

	it("should handle null result", () => {
		expect(formatToolResult(null).text).toBe("null");
	});

	it("should JSON.stringify number results", () => {
		expect(formatToolResult(42).text).toBe("42");
	});

	it("should JSON.stringify boolean results", () => {
		expect(formatToolResult(true).text).toBe("true");
	});
});

// ---------------------------------------------------------------------------
// mimeToExt — MIME type to file extension mapping
// ---------------------------------------------------------------------------

describe("mimeToExt", () => {
	it("should map image/png to png", () => {
		expect(mimeToExt("image/png")).toBe("png");
	});

	it("should map image/jpeg to jpg", () => {
		expect(mimeToExt("image/jpeg")).toBe("jpg");
	});

	it("should map image/gif to gif", () => {
		expect(mimeToExt("image/gif")).toBe("gif");
	});

	it("should map image/webp to webp", () => {
		expect(mimeToExt("image/webp")).toBe("webp");
	});

	it("should map image/svg+xml to svg", () => {
		expect(mimeToExt("image/svg+xml")).toBe("svg");
	});

	it("should default to png for unknown types", () => {
		expect(mimeToExt("image/bmp")).toBe("png");
		expect(mimeToExt("application/octet-stream")).toBe("png");
	});
});

// ---------------------------------------------------------------------------
// createParameterSchema — JSON Schema to TypeBox conversion
// ---------------------------------------------------------------------------

describe("createParameterSchema", () => {
	it("should return empty Object for non-object schema type", () => {
		const schema = createParameterSchema({ type: "string" });
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties)).toHaveLength(0);
	});

	it("should return empty Object for schema without properties", () => {
		const schema = createParameterSchema({ type: "object" });
		expect(schema.type).toBe("object");
		expect(Object.keys(schema.properties)).toHaveLength(0);
	});

	it("should convert string property", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { name: { type: "string", description: "A name" } },
			required: ["name"],
		});
		expect(schema.properties.name).toBeDefined();
		expect(schema.properties.name.type).toBe("string");
		expect(schema.properties.name.description).toBe("A name");
	});

	it("should convert boolean property", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { flag: { type: "boolean" } },
			required: ["flag"],
		});
		expect(schema.properties.flag.type).toBe("boolean");
	});

	it("should convert number property", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { count: { type: "number" } },
			required: ["count"],
		});
		expect(schema.properties.count.type).toBe("number");
	});

	it("should convert integer property", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { count: { type: "integer" } },
			required: ["count"],
		});
		expect(schema.properties.count.type).toBe("integer");
	});

	it("should convert array property", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { items: { type: "array" } },
			required: ["items"],
		});
		expect(schema.properties.items.type).toBe("array");
	});

	it("should handle string enum via union of literals", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { mode: { type: "string", enum: ["fast", "slow"] } },
			required: ["mode"],
		});
		const modeProp = schema.properties.mode;
		expect(modeProp).toBeDefined();
		expect(modeProp.anyOf).toBeDefined();
		expect(modeProp.anyOf).toHaveLength(2);
	});

	it("should mark non-required properties as optional", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: {
				required_prop: { type: "string" },
				optional_prop: { type: "string" },
			},
			required: ["required_prop"],
		});
		expect(schema.required).toContain("required_prop");
		expect(schema.required).not.toContain("optional_prop");
	});

	it("should set additionalProperties to true", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { a: { type: "string" } },
		});
		expect(schema.additionalProperties).toBe(true);
	});

	it("should handle unknown property types as Any", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { data: {} },
			required: ["data"],
		});
		expect(schema.properties.data).toBeDefined();
	});

	it("should preserve description on any property type", () => {
		const schema = createParameterSchema({
			type: "object",
			properties: { x: { type: "boolean", description: "toggle" } },
			required: ["x"],
		});
		expect(schema.properties.x.description).toBe("toggle");
	});
});

// ---------------------------------------------------------------------------
// buildToolVisibilityKey / parseToolVisibilityKey — key format round-trip
// ---------------------------------------------------------------------------

describe("buildToolVisibilityKey", () => {
	it("should join server and tool names with separator", () => {
		const key = buildToolVisibilityKey("my-server", "my-tool");
		expect(key).toBe(`my-server${TOOL_VISIBILITY_KEY_SEPARATOR}my-tool`);
	});
});

describe("parseToolVisibilityKey", () => {
	it("should round-trip with buildToolVisibilityKey", () => {
		const key = buildToolVisibilityKey("server-a", "tool-b");
		const parsed = parseToolVisibilityKey(key);
		expect(parsed).toEqual({ serverName: "server-a", toolName: "tool-b" });
	});

	it("should return null for key without separator", () => {
		expect(parseToolVisibilityKey("no-separator")).toBeNull();
	});

	it("should return null for key with separator at start", () => {
		expect(parseToolVisibilityKey(`${TOOL_VISIBILITY_KEY_SEPARATOR}tool`)).toBeNull();
	});

	it("should return null for key with separator at end", () => {
		expect(parseToolVisibilityKey(`server${TOOL_VISIBILITY_KEY_SEPARATOR}`)).toBeNull();
	});

	it("should trim whitespace from parsed parts", () => {
		const key = ` server ${TOOL_VISIBILITY_KEY_SEPARATOR} tool `;
		const parsed = parseToolVisibilityKey(key);
		expect(parsed).toEqual({ serverName: "server", toolName: "tool" });
	});

	it("should return null if trimmed parts are empty", () => {
		const key = `  ${TOOL_VISIBILITY_KEY_SEPARATOR}  `;
		expect(parseToolVisibilityKey(key)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseDisabledToolKeys — parsing disabled tool configurations
// ---------------------------------------------------------------------------

describe("parseDisabledToolKeys", () => {
	it("should return empty set for null/undefined", () => {
		expect(parseDisabledToolKeys(null).size).toBe(0);
		expect(parseDisabledToolKeys(undefined).size).toBe(0);
	});

	it("should parse array format (server/tool strings)", () => {
		const result = parseDisabledToolKeys(["server-a/tool-1", "server-b/tool-2"]);
		expect(result.size).toBe(2);
		expect(result.has(buildToolVisibilityKey("server-a", "tool-1"))).toBe(true);
		expect(result.has(buildToolVisibilityKey("server-b", "tool-2"))).toBe(true);
	});

	it("should parse map format (server to tool array)", () => {
		const result = parseDisabledToolKeys({
			"server-a": ["tool-1", "tool-2"],
			"server-b": ["tool-3"],
		});
		expect(result.size).toBe(3);
		expect(result.has(buildToolVisibilityKey("server-a", "tool-1"))).toBe(true);
		expect(result.has(buildToolVisibilityKey("server-a", "tool-2"))).toBe(true);
		expect(result.has(buildToolVisibilityKey("server-b", "tool-3"))).toBe(true);
	});

	it("should skip invalid array items without slash separator", () => {
		const result = parseDisabledToolKeys(["valid/tool", "no-slash", "/leading", "trailing/"]);
		expect(result.size).toBe(1);
	});

	it("should skip non-string items in array", () => {
		const result = parseDisabledToolKeys(["valid/tool", 42, null, undefined]);
		expect(result.size).toBe(1);
	});

	it("should skip non-array tool values in map format", () => {
		const result = parseDisabledToolKeys({
			"server-a": ["tool-1"],
			"server-b": "not-an-array",
		});
		expect(result.size).toBe(1);
	});

	it("should skip non-string tool names in map format", () => {
		const result = parseDisabledToolKeys({
			"server-a": ["tool-1", 42, null],
		});
		expect(result.size).toBe(1);
	});

	it("should return empty set for non-object/non-array primitives", () => {
		expect(parseDisabledToolKeys("string").size).toBe(0);
		expect(parseDisabledToolKeys(42).size).toBe(0);
		expect(parseDisabledToolKeys(true).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// serializeToolVisibilitySettings — serialization
// ---------------------------------------------------------------------------

describe("serializeToolVisibilitySettings", () => {
	it("should produce grouped server-to-tools map", () => {
		const keys = new Set([
			buildToolVisibilityKey("server-a", "tool-1"),
			buildToolVisibilityKey("server-a", "tool-2"),
			buildToolVisibilityKey("server-b", "tool-3"),
		]);
		const result = serializeToolVisibilitySettings(keys);
		expect(result.disabledTools).toEqual({
			"server-a": ["tool-1", "tool-2"],
			"server-b": ["tool-3"],
		});
	});

	it("should sort servers alphabetically", () => {
		const keys = new Set([buildToolVisibilityKey("z-server", "tool"), buildToolVisibilityKey("a-server", "tool")]);
		const result = serializeToolVisibilitySettings(keys);
		const serverNames = Object.keys(result.disabledTools ?? {});
		expect(serverNames).toEqual(["a-server", "z-server"]);
	});

	it("should sort tools within each server", () => {
		const keys = new Set([buildToolVisibilityKey("server", "z-tool"), buildToolVisibilityKey("server", "a-tool")]);
		const result = serializeToolVisibilitySettings(keys);
		expect(result.disabledTools).toEqual({ server: ["a-tool", "z-tool"] });
	});

	it("should return empty disabledTools for empty set", () => {
		const result = serializeToolVisibilitySettings(new Set());
		expect(result.disabledTools).toEqual({});
	});

	it("should skip invalid keys without separator", () => {
		const keys = new Set(["invalid-no-separator"]);
		const result = serializeToolVisibilitySettings(keys);
		expect(result.disabledTools).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// parseDisabledToolKeys + serializeToolVisibilitySettings — round-trip
// ---------------------------------------------------------------------------

describe("tool visibility settings round-trip", () => {
	it("should round-trip map format through serialize then parse", () => {
		const original = {
			"server-a": ["tool-1", "tool-2"],
			"server-b": ["tool-3"],
		};
		const keys = parseDisabledToolKeys(original);
		const serialized = serializeToolVisibilitySettings(keys);
		const reparsed = parseDisabledToolKeys(serialized.disabledTools);
		expect(reparsed).toEqual(keys);
	});

	it("should round-trip array format through serialize then parse", () => {
		const original = ["server-a/tool-1", "server-b/tool-2"];
		const keys = parseDisabledToolKeys(original);
		const serialized = serializeToolVisibilitySettings(keys);
		const reparsed = parseDisabledToolKeys(serialized.disabledTools);
		expect(reparsed).toEqual(keys);
	});
});
