import { describe, expect, it } from "vitest";
import { expandArgs, parseFrontmatter } from "./index.ts";

describe("parseFrontmatter", () => {
	it("should parse YAML frontmatter and body", () => {
		const raw = "---\ndescription: My command\nauthor: test\n---\nBody content here";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("My command");
		expect(result.body).toBe("Body content here");
		expect(result.fields).toEqual({ description: "My command", author: "test" });
	});

	it("should return empty description and fields when no frontmatter", () => {
		const raw = "Just a plain markdown file\nwith multiple lines";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("");
		expect(result.body).toBe(raw);
		expect(result.fields).toEqual({});
	});

	it("should handle empty string", () => {
		const result = parseFrontmatter("");
		expect(result.description).toBe("");
		expect(result.body).toBe("");
		expect(result.fields).toEqual({});
	});

	it("should handle frontmatter with description only", () => {
		const raw = "---\ndescription: Hello world\n---\nContent";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("Hello world");
		expect(result.body).toBe("Content");
		expect(result.fields).toEqual({ description: "Hello world" });
	});

	it("should handle frontmatter with no description field", () => {
		const raw = "---\nauthor: someone\nversion: 1.0\n---\nBody text";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("");
		expect(result.fields).toEqual({ author: "someone", version: "1.0" });
		expect(result.body).toBe("Body text");
	});

	it("should handle frontmatter with empty body", () => {
		const raw = "---\ndescription: test\n---\n";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("test");
		expect(result.body).toBe("");
	});

	it("should handle multiline body after frontmatter", () => {
		const raw = "---\ndescription: cmd\n---\nLine 1\nLine 2\nLine 3";
		const result = parseFrontmatter(raw);
		expect(result.body).toBe("Line 1\nLine 2\nLine 3");
	});

	it("should handle fields with colons in values", () => {
		const raw = "---\ndescription: URL: https://example.com\n---\nBody";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("URL: https://example.com");
		expect(result.fields.description).toBe("URL: https://example.com");
	});

	it("should skip lines without colon separator", () => {
		const raw = "---\ndescription: valid\nno-colon-line\n---\nBody";
		const result = parseFrontmatter(raw);
		expect(result.fields).toEqual({ description: "valid" });
	});

	it("should trim keys and values", () => {
		const raw = "---\n  description  :  spaced value  \n---\nBody";
		const result = parseFrontmatter(raw);
		expect(result.fields.description).toBe("spaced value");
		expect(result.description).toBe("spaced value");
	});

	it("should not match incomplete frontmatter delimiters", () => {
		const raw = "---\ndescription: test\nNo closing delimiter";
		const result = parseFrontmatter(raw);
		expect(result.description).toBe("");
		expect(result.body).toBe(raw);
		expect(result.fields).toEqual({});
	});

	it("should handle multiple fields", () => {
		const raw = "---\nname: my-agent\ndescription: An agent\nmodel: claude\n---\nPrompt text";
		const result = parseFrontmatter(raw);
		expect(result.fields).toEqual({
			name: "my-agent",
			description: "An agent",
			model: "claude",
		});
		expect(result.description).toBe("An agent");
	});
});

describe("expandArgs", () => {
	it("should replace $ARGUMENTS with the full args string", () => {
		expect(expandArgs("Run $ARGUMENTS now", "foo bar")).toBe("Run foo bar now");
	});

	it("should replace $@ with the full args string", () => {
		expect(expandArgs("Run $@ now", "foo bar")).toBe("Run foo bar now");
	});

	it("should replace positional $1, $2, etc.", () => {
		expect(expandArgs("First: $1, Second: $2", "hello world")).toBe("First: hello, Second: world");
	});

	it("should replace both $ARGUMENTS and positional args", () => {
		const result = expandArgs("All: $ARGUMENTS, First: $1", "a b c");
		expect(result).toBe("All: a b c, First: a");
	});

	it("should handle empty args string", () => {
		expect(expandArgs("No args: $ARGUMENTS", "")).toBe("No args: ");
	});

	it("should handle template without placeholders", () => {
		expect(expandArgs("No placeholders here", "foo bar")).toBe("No placeholders here");
	});

	it("should handle single arg", () => {
		const result = expandArgs("$1 is $ARGUMENTS", "only");
		expect(result).toBe("only is only");
	});

	it("should leave unreferenced positional placeholders unreplaced", () => {
		expect(expandArgs("$1 and $3", "a b")).toBe("a and $3");
	});

	it("should handle multiple occurrences of $ARGUMENTS", () => {
		expect(expandArgs("$ARGUMENTS then $ARGUMENTS", "x")).toBe("x then x");
	});

	it("should handle multiple occurrences of $@", () => {
		expect(expandArgs("$@ and $@", "y z")).toBe("y z and y z");
	});

	it("should handle args with extra whitespace", () => {
		expect(expandArgs("$1 $2", "  a   b  ")).toBe("a b");
	});

	it("should replace all occurrences of the same positional arg", () => {
		expect(expandArgs("$1 then $1 again", "val")).toBe("val then val again");
	});

	it("should handle many positional args", () => {
		const result = expandArgs("$1-$2-$3-$4-$5", "a b c d e");
		expect(result).toBe("a-b-c-d-e");
	});

	it("should handle mixed $@ and $ARGUMENTS in same template", () => {
		const result = expandArgs("start $@ middle $ARGUMENTS end", "x y");
		expect(result).toBe("start x y middle x y end");
	});
});
