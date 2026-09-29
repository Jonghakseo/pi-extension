import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = path.join(SKILL_DIR, "app");
export const DIST_DIR = path.join(APP_DIR, "dist");
export const STATE_DIR = process.env.EXCAL_STATE_DIR || path.join(os.homedir(), ".cache", "pi-excalidraw");
export const STATE_FILE = path.join(STATE_DIR, "server.json");
export const TOKEN_FILE = path.join(STATE_DIR, "token");
export const REGISTRY_FILE = path.join(STATE_DIR, "files.json");
export const HISTORY_DIR = path.join(STATE_DIR, "history");
export const SNAPSHOT_DIR = path.join(STATE_DIR, "snapshots");
export const LOG_FILE = path.join(STATE_DIR, "server.log");
export const CHROME_PROFILE_DIR = path.join(STATE_DIR, "chrome-profile");

export function ensureStateDir() {
	fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

export function readToken() {
	ensureStateDir();
	try {
		const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
		if (token) return token;
	} catch {}
	const token = crypto.randomBytes(24).toString("hex");
	fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
	return token;
}

export function readJSON(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

export function sha(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}

/** Stable id for a diagram file, derived from its real absolute path. */
export function fileIdFor(absPath) {
	return crypto.createHash("sha1").update(absPath).digest("hex").slice(0, 12);
}

export function realPathOf(p) {
	const abs = path.resolve(p);
	try {
		return fs.realpathSync(abs);
	} catch {
		return abs;
	}
}

export function emptyScene() {
	return (
		JSON.stringify(
			{
				type: "excalidraw",
				version: 2,
				source: "pi-excalidraw",
				elements: [],
				appState: { viewBackgroundColor: "#ffffff", gridSize: 20 },
				files: {},
			},
			null,
			2,
		) + "\n"
	);
}

export function writeFileAtomic(file, content) {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}
