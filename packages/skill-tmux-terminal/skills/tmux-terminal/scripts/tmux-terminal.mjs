#!/usr/bin/env node
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, chmod, mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const SOCKET_NAME = "pi-tmux-terminal";
export const MAX_CAPTURE_LINES = 200;
export const MAX_CAPTURE_BYTES = 5 * 1024;
export const MAX_PASTE_BYTES = 5 * 1024 * 1024;
const KEY_NAMES = new Set([
	"Enter",
	"Escape",
	"Tab",
	"BTab",
	"Space",
	"BSpace",
	"DC",
	"IC",
	"Up",
	"Down",
	"Left",
	"Right",
	"Home",
	"End",
	"PPage",
	"NPage",
	"C-c",
	"C-d",
	"C-z",
	"C-l",
	"C-r",
	"C-u",
	"C-w",
	"F1",
	"F2",
	"F3",
	"F4",
	"F5",
	"F6",
	"F7",
	"F8",
	"F9",
	"F10",
	"F11",
	"F12",
]);

export class TerminalError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

export function ownerHash(owner) {
	return createHash("sha256").update(owner).digest("hex").slice(0, 16);
}

export function sanitizeSegment(value) {
	const cleaned = String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return (cleaned || "owner").slice(0, 32);
}

export function sessionName(owner, helperId = randomId()) {
	return `pi-${sanitizeSegment(owner)}-${helperId}`;
}

export function randomId() {
	return randomBytes(12).toString("hex");
}

/** Quote a helper-generated path for the shell tmux uses to launch a pane. */
export function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function isNamedKey(key) {
	return KEY_NAMES.has(key);
}

export function newPasteBuffer(owner) {
	return `pi-paste-${ownerHash(owner)}-${randomId()}`;
}

export function truncateCapture(value, maxLines = MAX_CAPTURE_LINES, maxBytes = MAX_CAPTURE_BYTES) {
	const lines = String(value)
		.split("\n")
		.slice(-Math.max(1, Math.min(MAX_CAPTURE_LINES, maxLines)));
	const text = lines.join("\n");
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

	const codePoints = Array.from(text);
	const suffix = [];
	let bytes = 0;
	for (let index = codePoints.length - 1; index >= 0; index -= 1) {
		const width = Buffer.byteLength(codePoints[index], "utf8");
		if (bytes + width > maxBytes) break;
		suffix.push(codePoints[index]);
		bytes += width;
	}
	return suffix.reverse().join("");
}

export function parseTmuxStatus(line) {
	const [session, owner, helperId, tempPath, title, createdAt, paneDead, paneDeadStatus, panePid, command] = String(
		line,
	)
		.trimEnd()
		.split("\t");
	if (!session || owner === undefined)
		throw new TerminalError("tmux_format", "tmux returned an incomplete status record");
	return {
		session,
		owner,
		helperId,
		tempPath,
		title,
		createdAt,
		paneDead: paneDead === "1",
		paneDeadStatus: paneDeadStatus === "" ? null : Number(paneDeadStatus),
		panePid: panePid === "" ? null : Number(panePid),
		command,
	};
}

export function parseTmuxList(output) {
	if (!output.trim()) return [];
	return output
		.trimEnd()
		.split("\n")
		.map((line) => {
			const [session, owner, helperId, tempPath, title, createdAt] = line.split("\t");
			return { session, owner, helperId, tempPath, title, createdAt };
		});
}

function tmuxBinary(value = process.env.TMUX_BIN || "tmux") {
	return value;
}

async function runTmux(args, options = {}) {
	const binary = tmuxBinary(options.tmuxBin);
	try {
		return await execFile(binary, ["-L", SOCKET_NAME, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 });
	} catch (error) {
		const detail = error.stderr?.trim() || error.message;
		throw new TerminalError("tmux", detail);
	}
}

function resolveOwner(owner) {
	const value = owner || process.env.PI_SESSION_ID;
	if (!value) throw new TerminalError("owner_required", "PI_SESSION_ID or --owner is required");
	if (/[\0\n\t]/.test(value)) throw new TerminalError("invalid_owner", "owner contains an unsupported character");
	return value;
}

function ownerRoot(owner) {
	return join(tmpdir(), "pi-tmux-terminal", ownerHash(owner));
}

function assertManagedTempPath(owner, tempPath) {
	const root = resolve(ownerRoot(owner));
	const candidate = resolve(tempPath);
	const remaining = relative(root, candidate);
	if (!remaining || remaining.startsWith("..") || remaining.includes("..")) {
		throw new TerminalError("temp_path", "session metadata has an unsafe temporary path");
	}
	return candidate;
}

async function removeTempPath(owner, tempPath) {
	if (!tempPath) return;
	await rm(assertManagedTempPath(owner, tempPath), { recursive: true, force: true });
}

async function removeOwnerRootIfEmpty(owner) {
	try {
		await rmdir(ownerRoot(owner));
	} catch (error) {
		if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
	}
}

async function existingSessions(options = {}) {
	try {
		const result = await runTmux(
			[
				"list-sessions",
				"-F",
				"#{session_name}\t#{@pi_owner}\t#{@pi_helper_id}\t#{@pi_temp_path}\t#{@pi_original_title}\t#{@pi_created_at}",
			],
			options,
		);
		return parseTmuxList(result.stdout);
	} catch (error) {
		if (error instanceof TerminalError && /no server running|no sessions|failed to connect/i.test(error.message))
			return [];
		throw error;
	}
}

export async function doctor(options = {}) {
	const binary = tmuxBinary(options.tmuxBin);
	try {
		const version = execFileSync(binary, ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
		let executable = binary;
		if (!binary.includes("/")) {
			executable =
				execFileSync("/usr/bin/which", [binary], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() ||
				binary;
		}
		return { supported: true, executable, version, socket: SOCKET_NAME };
	} catch (error) {
		return {
			supported: false,
			executable: binary,
			reason: `tmux is unavailable: ${error.message.split("\n")[0]}`,
			socket: SOCKET_NAME,
		};
	}
}

async function statusUnchecked(session, options = {}) {
	const target = `${session}:0.0`;
	const result = await runTmux(
		[
			"display-message",
			"-p",
			"-t",
			target,
			"#{session_name}\t#{@pi_owner}\t#{@pi_helper_id}\t#{@pi_temp_path}\t#{@pi_original_title}\t#{@pi_created_at}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}\t#{pane_current_command}",
		],
		options,
	);
	return parseTmuxStatus(result.stdout);
}

async function ownedStatus(owner, session, options = {}) {
	if (!session) throw new TerminalError("session_required", "--session is required");
	const status = await statusUnchecked(session, options);
	if (status.owner !== owner) throw new TerminalError("ownership", "session is not owned by this PI session");
	return status;
}

function shellPath(shell) {
	const chosen = shell || "/bin/bash";
	if (!chosen.startsWith("/") || chosen.includes("\n") || chosen.includes("\0")) {
		throw new TerminalError("invalid_shell", "--shell must be an absolute executable path");
	}
	return chosen;
}

async function writeExecutable(file, contents) {
	await writeFile(file, contents, { mode: 0o700, flag: "wx" });
	await chmod(file, 0o700);
}

export async function startSession({ owner: inputOwner, command, title = "", shell, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	if (typeof command !== "string" || command.length === 0)
		throw new TerminalError("command_required", "--command is required");
	if (typeof title !== "string" || /[\u0000\n\t]/.test(title))
		throw new TerminalError("invalid_title", "--title cannot contain a tab or newline");
	const interpreter = shellPath(shell);
	try {
		await access(interpreter, fsConstants.X_OK);
	} catch {
		throw new TerminalError("invalid_shell", `configured shell is not executable: ${interpreter}`);
	}

	const helperId = randomId();
	const session = sessionName(owner, helperId);
	const root = ownerRoot(owner);
	const tempPath = join(root, helperId);
	const commandPath = join(tempPath, "command.sh");
	const gatePath = join(tempPath, "gate.sh");
	const markerPath = join(tempPath, "release");
	let sessionCreated = false;
	let released = false;

	try {
		await mkdir(tempPath, { recursive: true, mode: 0o700 });
		await chmod(tempPath, 0o700);
		await writeExecutable(commandPath, `#!${interpreter}\n${command}\n`);
		await writeExecutable(
			gatePath,
			`#!/bin/sh\nwhile [ ! -e ${shellQuote(markerPath)} ]; do sleep 0.01; done\nexec ${shellQuote(commandPath)}\n`,
		);

		// The only shell-parsed pane command is a quote-tested, helper-generated path.
		await runTmux(["new-session", "-d", "-s", session, shellQuote(gatePath)], { tmuxBin });
		sessionCreated = true;
		await runTmux(["set-window-option", "-t", `${session}:0`, "remain-on-exit", "on"], { tmuxBin });
		const metadata = [
			["@pi_owner", owner],
			["@pi_helper_id", helperId],
			["@pi_temp_path", tempPath],
			["@pi_original_title", title],
			["@pi_created_at", new Date().toISOString()],
		];
		for (const [key, value] of metadata) {
			await runTmux(["set-option", "-t", session, key, value], { tmuxBin });
		}
		await writeFile(markerPath, "", { mode: 0o600, flag: "wx" });
		released = true;
		return { session, owner, helperId, tempPath, title };
	} catch (error) {
		if (!released) {
			if (sessionCreated) {
				try {
					await runTmux(["kill-session", "-t", session], { tmuxBin });
				} catch {
					/* best effort for only this new session */
				}
			}
			await rm(tempPath, { recursive: true, force: true });
			// A concurrent same-owner start may have populated the root after our snapshot.
			await removeOwnerRootIfEmpty(owner);
		}
		throw error;
	}
}

export async function statusSession({ owner: inputOwner, session, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	return ownedStatus(owner, session, { tmuxBin });
}

export async function captureSession({ owner: inputOwner, session, lines = MAX_CAPTURE_LINES, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	const status = await ownedStatus(owner, session, { tmuxBin });
	const requestedLines = Math.max(1, Math.min(MAX_CAPTURE_LINES, Number(lines) || MAX_CAPTURE_LINES));
	const result = await runTmux(["capture-pane", "-p", "-t", `${status.session}:0.0`, "-S", `-${requestedLines}`], {
		tmuxBin,
	});
	return { ...status, text: truncateCapture(result.stdout, requestedLines, MAX_CAPTURE_BYTES) };
}

export async function sendKeys({ owner: inputOwner, session, keys, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	const status = await ownedStatus(owner, session, { tmuxBin });
	if (!Array.isArray(keys) || keys.length === 0) throw new TerminalError("keys_required", "--keys is required");
	for (const key of keys) {
		if (!isNamedKey(key))
			throw new TerminalError(
				"invalid_key",
				`literal or unsupported key ${JSON.stringify(key)} rejected, use paste for text`,
			);
	}
	await runTmux(["send-keys", "-t", `${status.session}:0.0`, ...keys], { tmuxBin });
	return { session: status.session, keys };
}

export function assertPasteTextSize(text) {
	if (typeof text !== "string") throw new TerminalError("text_required", "paste text is required");
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_PASTE_BYTES) {
		throw new TerminalError("paste_too_large", `paste input exceeds the ${MAX_PASTE_BYTES}-byte limit`);
	}
	return bytes;
}

export async function pasteSession({ owner: inputOwner, session, text, tmuxBin } = {}) {
	const bytes = assertPasteTextSize(text);
	const owner = resolveOwner(inputOwner);
	const status = await ownedStatus(owner, session, { tmuxBin });
	const pasteFile = join(assertManagedTempPath(owner, status.tempPath), `.paste-${randomId()}`);
	const buffer = newPasteBuffer(owner);
	let loaded = false;
	try {
		await writeFile(pasteFile, text, { mode: 0o600, flag: "wx" });
		await chmod(pasteFile, 0o600);
		await runTmux(["load-buffer", "-b", buffer, pasteFile], { tmuxBin });
		loaded = true;
		await runTmux(["paste-buffer", "-d", "-b", buffer, "-t", `${status.session}:0.0`], { tmuxBin });
		loaded = false; // -d deletes it after a successful paste
		return { session: status.session, bytes };
	} finally {
		await unlink(pasteFile).catch(() => {});
		if (loaded) await runTmux(["delete-buffer", "-b", buffer], { tmuxBin }).catch(() => {});
	}
}

export async function listOwned({ owner: inputOwner, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	const sessions = await existingSessions({ tmuxBin });
	return sessions.filter((session) => session.owner === owner);
}

export async function killSession({ owner: inputOwner, session, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	const status = await ownedStatus(owner, session, { tmuxBin });
	await runTmux(["kill-session", "-t", status.session], { tmuxBin });
	await removeTempPath(owner, status.tempPath);
	return { session: status.session, killed: true };
}

export async function cleanupOwner({ owner: inputOwner, tmuxBin } = {}) {
	const owner = resolveOwner(inputOwner);
	const sessions = await listOwned({ owner, tmuxBin });
	const removed = [];
	for (const session of sessions) {
		// Re-check ownership immediately before destructive work.
		await killSession({ owner, session: session.session, tmuxBin });
		removed.push(session.session);
	}
	// Never recursively remove the owner root. A same-owner start may have created
	// a new session directory after listOwned() took its snapshot.
	await removeOwnerRootIfEmpty(owner);
	return { owner, removed };
}

function usage() {
	return "usage: tmux-terminal.mjs <doctor|start|capture|status|send-keys|paste|list|kill|cleanup> [--owner OWNER]";
}

function parseCli(argv) {
	const [action, ...rest] = argv;
	if (!action) throw new TerminalError("action_required", usage());
	const options = { action, keys: [] };
	for (let index = 0; index < rest.length; index += 1) {
		const token = rest[index];
		if (!token.startsWith("--")) throw new TerminalError("invalid_argument", `unexpected argument: ${token}`);
		const key = token.slice(2);
		const value = rest[index + 1];
		if (["owner", "session", "command", "title", "shell", "lines", "text", "file", "keys", "key"].includes(key)) {
			if (value === undefined) throw new TerminalError("invalid_argument", `${token} requires a value`);
			index += 1;
			if (key === "key") options.keys.push(value);
			else if (key === "keys") options.keys.push(...value.split(",").filter(Boolean));
			else options[key] = value;
		} else throw new TerminalError("invalid_argument", `unknown option: ${token}`);
	}
	return options;
}

export async function readPasteText(options, stdin = process.stdin) {
	if (options.text !== undefined) {
		assertPasteTextSize(options.text);
		return options.text;
	}
	if (options.file) {
		const file = await stat(options.file);
		if (file.size > MAX_PASTE_BYTES) {
			throw new TerminalError("paste_too_large", `paste input exceeds the ${MAX_PASTE_BYTES}-byte limit`);
		}
		const text = await readFile(options.file, "utf8");
		assertPasteTextSize(text);
		return text;
	}
	if (!stdin.isTTY) {
		const chunks = [];
		let bytes = 0;
		for await (const chunk of stdin) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > MAX_PASTE_BYTES) {
				throw new TerminalError("paste_too_large", `paste input exceeds the ${MAX_PASTE_BYTES}-byte limit`);
			}
			chunks.push(buffer);
		}
		return Buffer.concat(chunks, bytes).toString("utf8");
	}
	throw new TerminalError("text_required", "provide --text, --file, or stdin for paste");
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseCli(argv);
	let result;
	switch (options.action) {
		case "doctor":
			result = await doctor(options);
			process.stdout.write(`${JSON.stringify({ ok: result.supported, ...result })}\n`);
			if (!result.supported) process.exitCode = 1;
			return result;
		case "start":
			result = await startSession(options);
			break;
		case "capture":
			result = await captureSession(options);
			break;
		case "status":
			result = await statusSession(options);
			break;
		case "send-keys":
			result = await sendKeys(options);
			break;
		case "paste":
			result = await pasteSession({ ...options, text: await readPasteText(options) });
			break;
		case "list":
			result = await listOwned(options);
			break;
		case "kill":
			result = await killSession(options);
			break;
		case "cleanup":
			result = await cleanupOwner(options);
			break;
		default:
			throw new TerminalError("invalid_action", `unsupported action: ${options.action}`);
	}
	process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
	return result;
}

function isDirectExecution(moduleUrl, argvPath) {
	if (!argvPath) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
	} catch {
		return false;
	}
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
	main().catch((error) => {
		process.stdout.write(
			`${JSON.stringify({ ok: false, error: { code: error.code || "error", message: error.message } })}\n`,
		);
		process.exitCode = 1;
	});
}
