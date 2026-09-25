import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
const AUTH_TIMEOUT_MS = 10 * 60_000;
const REGISTRY_RETRIES = 18;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openBrowser(url) {
	const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
	if (!command) return;
	const child = spawn(command, [url], { stdio: "ignore" });
	child.on("error", () => process.stderr.write("브라우저를 열지 못했습니다. 위 npm 승인 URL을 직접 여세요.\n"));
}

function authUrls(text) {
	return [...text.matchAll(/https:\/\/www\.npmjs\.com\/[^\s<>"']+/g)]
		.map(([url]) => url)
		.filter((url) => {
			const parsed = new URL(url);
			if (url.includes("***")) return false;
			return (
				parsed.pathname.startsWith("/auth/cli/") ||
				(parsed.pathname === "/login" && parsed.searchParams.get("next")?.startsWith("/login/cli/"))
			);
		});
}

function ptyCommand(command, args) {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error("Publishing requires a POSIX PTY on macOS or Linux.");
	}
	return ["python3", [fileURLToPath(new URL("./deploy-pty.py", import.meta.url)), command, ...args]];
}

export async function runCommand(command, args, { cwd, quiet = false, timeoutMs, onAuthUrl, tty = false } = {}) {
	return new Promise((resolve, reject) => {
		const [executable, parameters] = tty ? ptyCommand(command, args) : [command, args];
		const child = spawn(executable, parameters, {
			cwd,
			stdio: [tty ? "pipe" : "ignore", "pipe", "pipe"],
			env: { ...process.env, NPM_CONFIG_REGISTRY: REGISTRY },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const seen = new Set();
		let entered = false;
		const pending = { stdout: "", stderr: "" };
		const consume = (kind, chunk) => {
			const text = chunk.toString();
			if (kind === "stdout") stdout += text;
			else stderr += text;
			if (!quiet) (kind === "stdout" ? process.stdout : process.stderr).write(text);
			pending[kind] += text;
			const lines = pending[kind].split("\n");
			pending[kind] = lines.pop() ?? "";
			if (tty && !entered && pending[kind].includes("Press ENTER to open in the browser")) {
				entered = true;
				child.stdin.write("\n");
			}
			for (const line of lines) {
				for (const url of authUrls(line)) {
					if (!seen.has(url)) {
						seen.add(url);
						onAuthUrl?.(url);
					}
				}
			}
		};
		child.stdout.on("data", (chunk) => consume("stdout", chunk));
		child.stderr.on("data", (chunk) => consume("stderr", chunk));
		const timer = timeoutMs
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, timeoutMs)
			: null;
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			child.stdin?.destroy();
			for (const line of Object.values(pending)) {
				for (const url of authUrls(line)) {
					if (!seen.has(url)) onAuthUrl?.(url);
				}
			}
			resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
		});
	});
}

function requireSuccess(result, label) {
	if (result.code !== 0) throw new Error(`${label} failed (exit ${result.code}).`);
	return result.stdout.trim();
}

function parseStableVersion(version) {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) throw new Error(`Automatic patch bump requires a stable semver: ${version}`);
	return match.slice(1).map(Number);
}

function compareVersions(a, b) {
	const left = parseStableVersion(a);
	const right = parseStableVersion(b);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] - right[i];
	}
	return 0;
}

export async function deployPackage({ root, slug, run = runCommand, onAuthUrl = openBrowser, wait = sleep }) {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug ?? ""))
		throw new Error("Specify one package slug, e.g. pnpm deploy memory-layer.");
	const packagePath = path.join(root, "packages", slug, "package.json");
	const raw = await fs.readFile(packagePath, "utf8");
	const pkg = JSON.parse(raw);
	if (!pkg.name || !pkg.version || pkg.private) throw new Error(`Package ${slug} cannot be published.`);
	const invoke = (command, args, options = {}) => run(command, args, { cwd: root, ...options });
	const registryArg = `--registry=${REGISTRY}`;
	requireSuccess(await invoke("python3", ["--version"], { quiet: true }), "Python PTY prerequisite");

	const whoami = await invoke("npm", ["whoami", registryArg], { quiet: true });
	if (whoami.code !== 0) {
		if (!/\b(E401|ENEEDAUTH)\b|unauthorized|not logged in/i.test(whoami.stderr)) {
			throw new Error("npm whoami failed before login; check registry connectivity.");
		}
		process.stdout.write("npm 로그인이 필요합니다. 브라우저에서 승인해 주세요.\n");
		requireSuccess(
			await invoke("npm", ["login", "--auth-type=web", registryArg], { timeoutMs: AUTH_TIMEOUT_MS, onAuthUrl }),
			"npm login",
		);
	}
	requireSuccess(await invoke("npm", ["whoami", registryArg], { quiet: true }), "npm whoami");

	const versionsResult = await invoke("npm", ["view", pkg.name, "versions", "--json", registryArg, "--prefer-online"], {
		quiet: true,
	});
	if (versionsResult.code !== 0 && !/\bE404\b/.test(versionsResult.stderr))
		throw new Error("Could not read npm package versions.");
	const listed = versionsResult.code === 0 ? JSON.parse(versionsResult.stdout) : [];
	const versions = typeof listed === "string" ? [listed] : listed;
	if (!Array.isArray(versions) || !versions.every((value) => typeof value === "string")) {
		throw new Error("Unexpected npm versions response.");
	}
	const latest = versions.length
		? requireSuccess(
				await invoke("npm", ["view", pkg.name, "dist-tags.latest", registryArg, "--prefer-online"], { quiet: true }),
				"npm latest lookup",
			)
		: null;
	let version = pkg.version;
	if (latest && compareVersions(version, latest) < 0)
		throw new Error(`Local ${version} is older than npm latest ${latest}; choose a version manually.`);
	if (versions.includes(version)) {
		if (version !== latest)
			throw new Error(`Published ${version} is not npm latest ${latest}; choose a version manually.`);
		const [major, minor, patch] = parseStableVersion(version);
		let next = patch + 1;
		while (versions.includes(`${major}.${minor}.${next}`)) next++;
		version = `${major}.${minor}.${next}`;
		await fs.writeFile(
			packagePath,
			raw.replace(/("version"\s*:\s*")[^"]+(")/, (_match, prefix, suffix) => `${prefix}${version}${suffix}`),
		);
		process.stdout.write(`${pkg.name}: ${pkg.version} → ${version} (patch)\n`);
	}

	requireSuccess(await invoke("pnpm", ["run", "verify:strict"]), "strict verification");
	const publishArgs = ["--filter", pkg.name, "publish", "--access", "public", "--no-git-checks"];
	const dryRun = await invoke("pnpm", [...publishArgs, "--dry-run"]);
	requireSuccess(dryRun, "single-package dry-run");
	if (!(dryRun.stdout + dryRun.stderr).includes(`${pkg.name}@${version}`))
		throw new Error("Dry-run package/version mismatch.");
	const exists = await invoke("npm", ["view", `${pkg.name}@${version}`, "version", registryArg, "--prefer-online"], {
		quiet: true,
	});
	if (exists.code === 0 || !/\bE404\b/.test(exists.stderr))
		throw new Error(`Version ${version} is already published or registry check failed.`);

	const publish = await invoke("pnpm", publishArgs, { timeoutMs: AUTH_TIMEOUT_MS, onAuthUrl, tty: true });
	for (let attempt = 0; attempt < REGISTRY_RETRIES; attempt++) {
		const result = await invoke("npm", ["view", `${pkg.name}@${version}`, "version", registryArg, "--prefer-online"], {
			quiet: true,
		});
		if (result.code === 0 && result.stdout.trim() === version) {
			process.stdout.write(`Registry confirmed: ${pkg.name}@${version}\n`);
			return version;
		}
		if (result.code !== 0 && !/\bE404\b/.test(result.stderr)) throw new Error("Registry verification failed.");
		if (attempt < REGISTRY_RETRIES - 1) await wait(10_000);
	}
	throw new Error(
		`Publish exited ${publish.code}; ${pkg.name}@${version} did not appear in the registry within 3 minutes.`,
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	deployPackage({ root: path.resolve(import.meta.dirname, ".."), slug: process.argv[2] }).catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
