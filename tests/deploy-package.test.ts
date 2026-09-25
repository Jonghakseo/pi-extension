import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deployPackage, runCommand } from "../scripts/deploy-package.mjs";

const roots: string[] = [];
const name = "@ryan_nookpi/pi-extension-example";
const missing = { code: 1, stdout: "", stderr: "npm error code E404" };

async function fixture(version = "1.2.3") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-deploy-test-"));
	roots.push(root);
	await fs.mkdir(path.join(root, "packages", "example"), { recursive: true });
	await fs.writeFile(path.join(root, "packages", "example", "package.json"), `${JSON.stringify({ name, version })}\n`);
	return root;
}

function registry(root: string, { signedIn = true, strictPasses = true, dryRunPasses = true, latest = "1.2.3" } = {}) {
	const events: string[] = [];
	let authenticated = signedIn;
	let published: string | undefined;
	let checks = 0;
	const run = async (
		command: string,
		args: string[],
		options: { onAuthUrl?: (url: string) => void; tty?: boolean },
	) => {
		const key = `${command} ${args.join(" ")}`;
		if (key === "python3 --version") return { code: 0, stdout: "Python 3.14.6\n", stderr: "" };
		if (key.startsWith("npm whoami"))
			return authenticated ? { code: 0, stdout: "tester\n", stderr: "" } : { code: 1, stdout: "", stderr: "E401" };
		if (key.startsWith("npm login")) {
			events.push("login");
			options.onAuthUrl?.("https://www.npmjs.com/login?next=/login/cli/test");
			authenticated = true;
			return { code: 0, stdout: "Logged in\n", stderr: "" };
		}
		if (key.includes("versions --json")) return { code: 0, stdout: JSON.stringify(["1.2.3"]), stderr: "" };
		if (key.includes("dist-tags.latest")) return { code: 0, stdout: `${latest}\n`, stderr: "" };
		if (key.startsWith("npm view") && key.includes(" version ")) {
			checks++;
			return published && checks > 2 ? { code: 0, stdout: `${published}\n`, stderr: "" } : missing;
		}
		if (key === "pnpm run verify:strict") {
			events.push("strict");
			return { code: strictPasses ? 0 : 1, stdout: "", stderr: "" };
		}
		if (key.startsWith(`pnpm --filter ${name} publish`)) {
			const { version } = JSON.parse(await fs.readFile(path.join(root, "packages", "example", "package.json"), "utf8"));
			if (args.includes("--dry-run")) {
				events.push("dry-run");
				return { code: dryRunPasses ? 0 : 1, stdout: `+ ${name}@${version} (dry-run)\n`, stderr: "" };
			}
			if (!events.includes("strict") || !events.includes("dry-run")) throw new Error("published before verification");
			if (!options.tty) throw new Error("publish must run in a PTY for npm web OTP");
			events.push("publish");
			options.onAuthUrl?.("https://www.npmjs.com/auth/cli/test");
			published = version;
			return { code: 0, stdout: `+ ${name}@${version}\n`, stderr: "" };
		}
		throw new Error(`Unexpected command: ${key}`);
	};
	return {
		run,
		events,
		get published() {
			return published;
		},
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("common package deploy", () => {
	it("handles browser login, patches an already published version, verifies, publishes, and confirms the registry", async () => {
		const root = await fixture();
		const npm = registry(root, { signedIn: false });
		const opened: string[] = [];
		const version = await deployPackage({
			root,
			slug: "example",
			run: npm.run,
			onAuthUrl: (url: string) => opened.push(url),
			wait: async () => {},
		});
		expect(version).toBe("1.2.4");
		expect(JSON.parse(await fs.readFile(path.join(root, "packages", "example", "package.json"), "utf8")).version).toBe(
			version,
		);
		expect(npm.published).toBe(version);
		expect(npm.events).toEqual(["login", "strict", "dry-run", "publish"]);
		expect(opened).toHaveLength(2);
	});

	it("does not publish when strict verification fails", async () => {
		const root = await fixture();
		const npm = registry(root, { strictPasses: false });
		await expect(deployPackage({ root, slug: "example", run: npm.run, wait: async () => {} })).rejects.toThrow(
			"strict verification failed",
		);
		expect(npm.published).toBeUndefined();
		expect(npm.events).toEqual(["strict"]);
	});

	it("does not publish when the single-package dry-run fails", async () => {
		const root = await fixture();
		const npm = registry(root, { dryRunPasses: false });
		await expect(deployPackage({ root, slug: "example", run: npm.run, wait: async () => {} })).rejects.toThrow(
			"single-package dry-run failed",
		);
		expect(npm.published).toBeUndefined();
		expect(npm.events).toEqual(["strict", "dry-run"]);
	});

	it("refuses to downgrade the registry latest tag or accept an invalid slug", async () => {
		const root = await fixture("1.2.2");
		const npm = registry(root);
		await expect(deployPackage({ root, slug: "example", run: npm.run })).rejects.toThrow("older than npm latest");
		await expect(deployPackage({ root, slug: "../example", run: npm.run })).rejects.toThrow("Specify one package slug");
		expect(npm.published).toBeUndefined();
		expect(JSON.parse(await fs.readFile(path.join(root, "packages", "example", "package.json"), "utf8")).version).toBe(
			"1.2.2",
		);
	});

	it("opens the real npm approval URL and ignores a redacted URL", async () => {
		const opened: string[] = [];
		const result = await runCommand(process.execPath, ["-e", 'console.log("https://www.npmjs.com/auth/cli/***")'], {
			quiet: true,
			onAuthUrl: (url: string) => opened.push(url),
		});
		expect(result.code).toBe(0);
		expect(opened).toEqual([]);
	});

	it("provides a real PTY to publish and answers npm's browser prompt once", async () => {
		const opened: string[] = [];
		const code = [
			"if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2);",
			'console.log("Authenticate your account at:\\nhttps://www.npmjs.com/auth/cli/test-pty");',
			'process.stdout.write("Press ENTER to open in the browser...");',
			'process.stdin.once("data", () => { console.log("approved"); process.exit(0); });',
		].join("");
		const result = await runCommand(process.execPath, ["-e", code], {
			tty: true,
			quiet: true,
			timeoutMs: 5_000,
			onAuthUrl: (url: string) => opened.push(url),
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("approved");
		expect(opened).toEqual(["https://www.npmjs.com/auth/cli/test-pty"]);
	});

	it("detects npm's web approval URL without a TTY", async () => {
		const opened: string[] = [];
		const loginUrl = "https://www.npmjs.com/login?next=/login/cli/test";
		const publishUrl = "https://www.npmjs.com/auth/cli/test";
		const result = await runCommand(
			process.execPath,
			["-e", `console.log(${JSON.stringify(loginUrl)});console.error(${JSON.stringify(publishUrl)})`],
			{
				quiet: true,
				onAuthUrl: (url: string) => opened.push(url),
			},
		);
		expect(result.code).toBe(0);
		expect(opened).toEqual([loginUrl, publishUrl]);
	});
});
