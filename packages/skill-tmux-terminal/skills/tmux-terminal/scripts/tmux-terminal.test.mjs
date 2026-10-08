import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertPasteTextSize,
	captureSession,
	cleanupOwner,
	doctor,
	isNamedKey,
	killSession,
	listOwned,
	MAX_PASTE_BYTES,
	newPasteBuffer,
	ownerHash,
	parseTmuxList,
	parseTmuxStatus,
	pasteSession,
	readPasteText,
	sanitizeSegment,
	sendKeys,
	sessionName,
	shellQuote,
	startSession,
	statusSession,
	TerminalError,
	truncateCapture,
} from "./tmux-terminal.mjs";

const owner = (suffix) => `tmux-terminal-test-${suffix}-${process.pid}`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForDead(input) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const status = await statusSession(input);
		if (status.paneDead) return status;
		await delay(10); // Poll process scheduling only, never an assumed command duration.
	}
	throw new Error(`pane did not exit: ${input.session}`);
}

function defaultServerSnapshot() {
	try {
		return execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
}

async function start(ownerName, command) {
	const started = await startSession({ owner: ownerName, command });
	return started;
}

test("pure helpers keep owner and generated-shell boundaries deterministic", () => {
	assert.equal(sanitizeSegment("PI Session / 01"), "pi-session-01");
	assert.equal(sanitizeSegment("---"), "owner");
	assert.equal(ownerHash("a"), ownerHash("a"));
	assert.notEqual(ownerHash("a"), ownerHash("b"));
	assert.match(sessionName("PI Session", "abc123"), /^pi-pi-session-abc123$/);
	assert.equal(shellQuote("/tmp/a b/'c'"), "'/tmp/a b/'\"'\"'c'\"'\"''");
	assert.equal(isNamedKey("Enter"), true);
	assert.equal(isNamedKey("C-c"), true);
	assert.equal(isNamedKey("F12"), true);
	assert.equal(isNamedKey("literal text"), false);
	assert.notEqual(newPasteBuffer("same"), newPasteBuffer("same"));
});

test("paste input accepts exactly 5 MiB and rejects larger text, files, and stdin", async (t) => {
	const exact = "x".repeat(MAX_PASTE_BYTES);
	assert.equal(assertPasteTextSize(exact), MAX_PASTE_BYTES);
	assert.throws(
		() => assertPasteTextSize(`${exact}x`),
		(error) => error instanceof TerminalError && error.code === "paste_too_large",
	);

	const directory = await mkdir(join(tmpdir(), `tmux-terminal-paste-limit-${process.pid}`), { recursive: true }).then(
		() => join(tmpdir(), `tmux-terminal-paste-limit-${process.pid}`),
	);
	const exactFile = join(directory, "exact.txt");
	const oversizedFile = join(directory, "oversized.txt");
	await writeFile(exactFile, exact);
	await writeFile(oversizedFile, `${exact}x`);
	t.after(() => rm(directory, { recursive: true, force: true }));
	assert.equal((await readPasteText({ file: exactFile })).length, MAX_PASTE_BYTES);
	await assert.rejects(
		readPasteText({ file: oversizedFile }),
		(error) => error instanceof TerminalError && error.code === "paste_too_large",
	);

	const stdin = {
		isTTY: false,
		async *[Symbol.asyncIterator]() {
			yield Buffer.alloc(MAX_PASTE_BYTES);
			yield Buffer.from("x");
		},
	};
	await assert.rejects(
		readPasteText({}, stdin),
		(error) => error instanceof TerminalError && error.code === "paste_too_large",
	);
});

test("capture truncation is line-bounded, byte-bounded, and UTF-8 safe", () => {
	assert.equal(truncateCapture("one\ntwo\nthree", 2, 1024), "two\nthree");
	const output = truncateCapture("x한글🙂", 200, 7);
	assert.ok(Buffer.byteLength(output, "utf8") <= 7);
	assert.equal(output.includes("�"), false);
});

test("capture truncation keeps content when the pane's unused bottom rows are blank", () => {
	// tmux pads every capture to the full pane height, so slicing before dropping the
	// blank tail used to return an empty screen for any small line budget.
	const padded = `one\ntwo\nthree${"\n   ".repeat(21)}`;
	assert.equal(truncateCapture(padded, 2, 1024), "two\nthree");
	assert.equal(truncateCapture(padded, 1, 1024), "three");
	assert.equal(truncateCapture("\n\n\n", 5, 1024), "");
});

test("tmux format parsers retain metadata and dead status", () => {
	assert.deepEqual(parseTmuxList("s\to\th\t/tmp/x\tt\t2026\n"), [
		{ session: "s", owner: "o", helperId: "h", tempPath: "/tmp/x", title: "t", createdAt: "2026" },
	]);
	const status = parseTmuxStatus("s\to\th\t/tmp/x\tt\t2026\t1\t7\t123\tbash\n");
	assert.equal(status.paneDead, true);
	assert.equal(status.paneDeadStatus, 7);
	assert.equal(status.panePid, 123);
});

test("doctor reports a usable tmux and a clear unavailable capability", async () => {
	const available = await doctor();
	assert.equal(available.supported, true);
	assert.match(available.version, /^tmux /);
	const unavailable = await doctor({ tmuxBin: "/definitely/missing/tmux" });
	assert.equal(unavailable.supported, false);
	assert.match(unavailable.reason, /unavailable/);
});

test("CLI entrypoint works through a symlink and preserves doctor exit codes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "tmux-terminal-cli-symlink-"));
	const script = fileURLToPath(new URL("./tmux-terminal.mjs", import.meta.url));
	const linkedScript = join(directory, "tmux-terminal.mjs");
	await symlink(script, linkedScript);
	t.after(() => rm(directory, { recursive: true, force: true }));

	const available = spawnSync(process.execPath, [linkedScript, "doctor", "--owner", owner("cli")], {
		encoding: "utf8",
	});
	assert.equal(available.status, 0, available.stderr);
	assert.equal(JSON.parse(available.stdout).supported, true);

	const unavailable = spawnSync(process.execPath, [linkedScript, "doctor", "--owner", owner("cli")], {
		encoding: "utf8",
		env: { ...process.env, TMUX_BIN: "/definitely/missing/tmux" },
	});
	assert.equal(unavailable.status, 1, unavailable.stderr);
	const unavailableResult = JSON.parse(unavailable.stdout);
	assert.equal(unavailableResult.ok, false);
	assert.equal(unavailableResult.supported, false);

	const help = spawnSync(process.execPath, [linkedScript, "help"], { encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /^usage: tmux-terminal\.mjs/);
	assert.match(help.stdout, /--lines N/);
});

test("capture returns the newest screen lines even when --lines is below the pane height", async (t) => {
	const currentOwner = owner("capture-lines");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	const started = await start(currentOwner, "printf 'FIRST\\nSECOND\\nTHIRD\\n'; while :; do sleep 1; done");
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if ((await captureSession({ owner: currentOwner, session: started.session })).text.includes("THIRD")) break;
		await delay(10);
	}
	// A default pane is 24 rows tall; line budgets below that used to return only blank rows.
	const narrow = await captureSession({ owner: currentOwner, session: started.session, lines: 3 });
	assert.deepEqual(narrow.text.split("\n"), ["FIRST", "SECOND", "THIRD"]);
	assert.equal((await captureSession({ owner: currentOwner, session: started.session, lines: 1 })).text, "THIRD");
});

test("a missing session reports session_not_found rather than a format failure", async (t) => {
	const currentOwner = owner("missing-session");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	// Keep the dedicated server alive: tmux then answers with empty stdout and exit 0.
	await start(currentOwner, "sleep 30");
	const missing = `pi-missing-${process.pid}`;
	for (const operation of [
		() => statusSession({ owner: currentOwner, session: missing }),
		() => captureSession({ owner: currentOwner, session: missing }),
		() => sendKeys({ owner: currentOwner, session: missing, keys: ["Enter"] }),
		() => killSession({ owner: currentOwner, session: missing }),
	]) {
		await assert.rejects(
			operation,
			(error) =>
				error instanceof TerminalError && error.code === "session_not_found" && error.message.includes(missing),
		);
	}
});

test("gated start preserves compound shell command semantics and immediate exit statuses", async (t) => {
	const currentOwner = owner("compound");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	const zero = await start(currentOwner, "printf one; printf two");
	const zeroStatus = await waitForDead({ owner: currentOwner, session: zero.session });
	assert.equal(zeroStatus.paneDeadStatus, 0);
	assert.match((await captureSession({ owner: currentOwner, session: zero.session })).text, /onetwo/);

	const semantics = await start(currentOwner, "printf 'a b' && printf ' $HOME' | tr a-z A-Z\nprintf '\\n한글'");
	const semanticStatus = await waitForDead({ owner: currentOwner, session: semantics.session });
	assert.equal(semanticStatus.paneDeadStatus, 0);
	const captured = (await captureSession({ owner: currentOwner, session: semantics.session })).text;
	assert.match(captured, /a b \$HOME/);
	assert.match(captured, /한글/);

	const seven = await start(currentOwner, "exit 7");
	assert.equal((await waitForDead({ owner: currentOwner, session: seven.session })).paneDeadStatus, 7);
});

test("raw selector receives Down then Enter", async (t) => {
	const currentOwner = owner("selector");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	const command =
		"python3 -u -c \"import sys,tty; tty.setraw(sys.stdin.fileno()); print('READY', flush=True); value=sys.stdin.buffer.read(4); print('SELECTED' if value == b'\\x1b[B\\r' else repr(value), flush=True)\"";
	const started = await start(currentOwner, command);
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if ((await captureSession({ owner: currentOwner, session: started.session })).text.includes("READY")) break;
		await delay(10);
	}
	await sendKeys({ owner: currentOwner, session: started.session, keys: ["Down", "Enter"] });
	await waitForDead({ owner: currentOwner, session: started.session });
	assert.match((await captureSession({ owner: currentOwner, session: started.session })).text, /SELECTED/);
});

test("REPL-style input accepts literal paste, Enter, and Ctrl-C", async (t) => {
	const currentOwner = owner("repl");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	const started = await start(
		currentOwner,
		`trap 'printf INT; exit 0' INT; printf READY; IFS= read -r value; printf "GOT:%s" "$value"; while :; do sleep 1; done`,
	);
	await pasteSession({ owner: currentOwner, session: started.session, text: "literal $ text" });
	await sendKeys({ owner: currentOwner, session: started.session, keys: ["Enter"] });
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if ((await captureSession({ owner: currentOwner, session: started.session })).text.includes("GOT:literal $ text"))
			break;
		await delay(10);
	}
	await sendKeys({ owner: currentOwner, session: started.session, keys: ["C-c"] });
	await waitForDead({ owner: currentOwner, session: started.session });
	const text = (await captureSession({ owner: currentOwner, session: started.session })).text;
	assert.match(text, /GOT:literal \$ text/);
	assert.match(text, /INT/);
});

test("multiline Unicode paste arrives exactly once and concurrent buffers do not cross", async (t) => {
	const currentOwner = owner("paste");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	const multi = await start(currentOwner, 'IFS= read -r a; IFS= read -r b; printf \'<%s>|<%s>\' "$a" "$b"');
	await pasteSession({ owner: currentOwner, session: multi.session, text: "하나\n둘\n" });
	await waitForDead({ owner: currentOwner, session: multi.session });
	const multiText = (await captureSession({ owner: currentOwner, session: multi.session })).text;
	assert.equal((multiText.match(/<하나>\|<둘>/g) || []).length, 1);

	const first = await start(currentOwner, "IFS= read -r v; printf 'VALUE:%s' \"$v\"");
	const second = await start(currentOwner, "IFS= read -r v; printf 'VALUE:%s' \"$v\"");
	await Promise.all([
		pasteSession({ owner: currentOwner, session: first.session, text: "alpha\n" }),
		pasteSession({ owner: currentOwner, session: second.session, text: "bravo\n" }),
	]);
	await Promise.all([
		waitForDead({ owner: currentOwner, session: first.session }),
		waitForDead({ owner: currentOwner, session: second.session }),
	]);
	assert.match((await captureSession({ owner: currentOwner, session: first.session })).text, /VALUE:alpha/);
	assert.match((await captureSession({ owner: currentOwner, session: second.session })).text, /VALUE:bravo/);
});

test("owner isolation blocks inspect, input, paste, kill, and cleanup of another owner", async (t) => {
	const ownerA = owner("owner-a");
	const ownerB = owner("owner-b");
	t.after(async () => {
		await cleanupOwner({ owner: ownerA });
		await cleanupOwner({ owner: ownerB });
	});
	const b = await start(ownerB, "sleep 30");
	for (const operation of [
		() => statusSession({ owner: ownerA, session: b.session }),
		() => captureSession({ owner: ownerA, session: b.session }),
		() => sendKeys({ owner: ownerA, session: b.session, keys: ["Enter"] }),
		() => pasteSession({ owner: ownerA, session: b.session, text: "nope" }),
		() => killSession({ owner: ownerA, session: b.session }),
	]) {
		await assert.rejects(operation, (error) => error instanceof TerminalError && error.code === "ownership");
	}
	await cleanupOwner({ owner: ownerA });
	assert.equal((await statusSession({ owner: ownerB, session: b.session })).owner, ownerB);
});

test("failed start after session creation removes its session and temporary directory", async (t) => {
	const failedOwner = owner("failed-after-create");
	const wrapper = join(tmpdir(), `tmux-terminal-fail-wrapper-${process.pid}.sh`);
	const available = await doctor();
	await writeFile(
		wrapper,
		`#!/bin/sh\nif [ "$3" = set-window-option ]; then echo forced failure >&2; exit 23; fi\nexec ${shellQuote(available.executable)} "$@"\n`,
		{ mode: 0o700 },
	);
	t.after(async () => {
		await cleanupOwner({ owner: failedOwner });
		await rm(wrapper, { force: true });
	});

	await assert.rejects(
		startSession({ owner: failedOwner, command: "sleep 1", tmuxBin: wrapper }),
		(error) => error instanceof TerminalError && /forced failure/.test(error.message),
	);
	assert.deepEqual(await listOwned({ owner: failedOwner }), []);
	const failedRoot = join(tmpdir(), "pi-tmux-terminal", ownerHash(failedOwner));
	const remaining = await readdir(failedRoot).catch((error) => (error.code === "ENOENT" ? [] : Promise.reject(error)));
	assert.deepEqual(remaining, []);
});

test("cleanup preserves same-owner temp paths created outside its session snapshot", async (t) => {
	const currentOwner = owner("cleanup-race");
	const root = join(tmpdir(), "pi-tmux-terminal", ownerHash(currentOwner));
	const concurrentPath = join(root, "concurrent-start");
	await mkdir(concurrentPath, { recursive: true, mode: 0o700 });
	t.after(() => rm(root, { recursive: true, force: true }));

	await cleanupOwner({ owner: currentOwner });
	await access(concurrentPath);
});

test("cleanup is owner-scoped and removes owned temporary files", async (t) => {
	const failedOwner = owner("cleanup-empty");
	const goodOwner = owner("good");
	t.after(async () => {
		await cleanupOwner({ owner: failedOwner });
		await cleanupOwner({ owner: goodOwner });
	});
	const good = await start(goodOwner, "sleep 30");
	await cleanupOwner({ owner: failedOwner });
	assert.equal((await statusSession({ owner: goodOwner, session: good.session })).owner, goodOwner);
	await cleanupOwner({ owner: goodOwner });
	await assert.rejects(access(good.tempPath), /ENOENT/);
});

test("dedicated socket leaves default tmux sessions untouched", async (t) => {
	const before = defaultServerSnapshot();
	const currentOwner = owner("default-server");
	t.after(() => cleanupOwner({ owner: currentOwner }));
	const started = await start(currentOwner, "printf done");
	await waitForDead({ owner: currentOwner, session: started.session });
	assert.equal(defaultServerSnapshot(), before);
});
