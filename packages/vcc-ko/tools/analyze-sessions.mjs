#!/usr/bin/env node
/**
 * 세션 분석기: 내 pi 세션을 샘플링해 현재 규칙 세트가 무엇을 잡고 놓치는지 보여준다.
 * RULES-GUIDE.md의 3단계 워크플로(관찰 → 규칙 작성 → 검증)에서 사용한다.
 *
 * 사용법:
 *   node --experimental-transform-types tools/analyze-sessions.mjs [--config <경로>] [--sample 10] [--session <파일>]
 *
 * 설정 파일은 프로덕션과 동일한 경로(~/.pi/agent/pi-vcc-ko-config.json)를 읽는다.
 * --config로 다른 파일을 지정하면 그 규칙 세트로 시뮬레이션한다 (원본 설정은 건드리지 않음).
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

if (args.includes("--config")) process.env.PI_VCC_KO_CONFIG_PATH = argOf("--config", "");
const SAMPLE = Number(argOf("--sample", "10"));
const ONE_SESSION = args.includes("--session") ? argOf("--session", "") : "";

const { loadSettings } = await import(join(SRC, "core", "settings.ts"));
const { compileRules } = await import(join(SRC, "core", "rules.ts"));
const { normalize } = await import(join(SRC, "core", "normalize.ts"));
const { filterNoise } = await import(join(SRC, "core", "filter-noise.ts"));
const { loadAllMessages } = await import(join(SRC, "core", "load-messages.ts"));
const { extractGoals } = await import(join(SRC, "extract", "goals.ts"));
const { extractPreferences } = await import(join(SRC, "extract", "preferences.ts"));
const { buildSections } = await import(join(SRC, "core", "build-sections.ts"));
const { collapseSkillText } = await import(join(SRC, "core", "skill-collapse.ts"));

const settings = loadSettings();
const { rules, errors } = compileRules(settings.rules, settings.disableBuiltinRules);
console.log(`설정: ${process.env.PI_VCC_KO_CONFIG_PATH ?? "~/.pi/agent/pi-vcc-ko-config.json"}`);
if (errors.length > 0) {
	console.log(`⚠ 무효 정규식 ${errors.length}건 (건너뜀):`);
	for (const e of errors) console.log(`   - ${e}`);
}
console.log(
	`규칙 수: agentNotices ${rules.agentNotices.length} / goalExclusions ${rules.goalExclusions.length} / blockerExclusions ${rules.blockerExclusions.length} / taskVerbs ${rules.taskVerbs.length} / preferencePatterns ${rules.preferencePatterns.length}`,
);

const ROOT = join(homedir(), ".pi", "agent", "sessions");
const files = [];
for (const dir of readdirSync(ROOT)) {
	try {
		for (const f of readdirSync(join(ROOT, dir))) {
			if (!f.endsWith(".jsonl")) continue;
			const p = join(ROOT, dir, f);
			const st = statSync(p);
			if (st.size > 10 * 1024 && st.size < 8 * 1024 * 1024) files.push({ p, m: st.mtimeMs });
		}
	} catch {}
}
files.sort((a, b) => b.m - a.m);
const sample = ONE_SESSION ? [{ p: ONE_SESSION }] : files.slice(0, SAMPLE);
console.log(`분석 대상: ${sample.length}개 세션\n`);

const clip = (s, n = 90) => s.replace(/\s+/g, " ").trim().slice(0, n);
const noticeHits = new Map();

for (const { p } of sample) {
	const name = p.split("/").pop().slice(11, 27);
	try {
		const { rawMessages } = loadAllMessages(p, true);
		const raw = normalize(rawMessages);
		const blocks = filterNoise(raw, rules);
		// 실제로 드롭된 공지 블록: agentNotices에 걸리는 user 블록 (정체성이 아닌 내용으로 판정)
		const dropped = raw.filter((b) => b.kind === "user" && rules.agentNotices.some((re) => re.test(b.text.trim())));
		const userBlocks = blocks.filter((b) => b.kind === "user");
		if (userBlocks.length === 0) continue;

		const goals = extractGoals(blocks, rules);
		const prefs = extractPreferences(blocks, rules);
		const secs = buildSections({ blocks, rules });

		console.log(`━━ ${name} — user 턴 ${userBlocks.length}개`);
		// 드롭된 공지 블록: 걸린 규칙의 패턴을 표시
		for (const d of dropped.slice(0, 2)) {
			const hit = rules.agentNotices.find((re) => re.test(d.text.trim()));
			const label = hit ? `규칙 /${clip(hit.source, 44)}/` : "규칙 없음";
			console.log(`  [드롭] ${clip(d.text, 70)}  ← ${label}`);
			noticeHits.set(label, (noticeHits.get(label) ?? 0) + 1);
		}
		// 첫 사용자 블록: 목표로 캡처된 라인 / 제외된 라인(어느 규칙인지)
		const first = userBlocks[0];
		const collapsed = collapseSkillText(first.text);
		// 목표 뒤에 붙는 표지: [Earlier requests] → [Scope change] 또는 [Latest request]
		const markerIdx = goals.findIndex((g) => /^\[(?:Earlier requests|Scope change|Latest request)\]$/.test(g));
		const firstGoals = markerIdx >= 0 ? goals.slice(0, markerIdx) : goals;
		for (const line of collapsed.split("\n").slice(0, 8)) {
			const t = line.trim();
			if (!t) continue;
			const captured = firstGoals.some((g) => clip(g, 40) === clip(t, 40));
			const exclusionHit = captured ? undefined : rules.goalExclusions.find((re) => re.test(t));
			const tag = captured ? "목표" : exclusionHit ? `제외← /${clip(exclusionHit.source, 40)}/` : "미채택";
			console.log(`  [${tag}] ${clip(t, 80)}`);
		}
		const earlierIdx = goals.indexOf("[Earlier requests]");
		const latestIdx = goals.findIndex((g) => g === "[Scope change]" || g === "[Latest request]");
		if (earlierIdx >= 0) console.log(`  [이전 요청] ${clip(goals.slice(earlierIdx + 1, latestIdx).join(" / "), 100)}`);
		if (latestIdx >= 0) {
			const tag = goals[latestIdx] === "[Scope change]" ? "스코프" : "최신 요청";
			console.log(`  [${tag}] ${clip(goals.slice(latestIdx + 1).join(" / "), 100)}`);
		}
		if (prefs.length > 0) console.log(`  [선호] ${prefs.map((x) => clip(x, 40)).join(" | ")}`);
		if (secs.outstandingContext.length > 0) console.log(`  [장애물] ${clip(secs.outstandingContext.join(" / "), 120)}`);
		console.log("");
	} catch {}
}

if (noticeHits.size > 0) {
	console.log("── agentNotices 적중 집계 (규칙# → 블록 수)");
	for (const [rule, count] of [...noticeHits.entries()].sort((a, b) => b[1] - a[1]))
		console.log(`   #${rule}: ${count}블록`);
}
