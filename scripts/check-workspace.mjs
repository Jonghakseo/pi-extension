import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const packagesDir = path.join(root, "packages");
const packageDirs = fs
	.readdirSync(packagesDir)
	.filter((name) => fs.existsSync(path.join(packagesDir, name, "package.json")));

const RELATIVE_IMPORT = /from\s*["'](\.[^"']+)["']/g;

/** Applies the npm `files` matching rules we rely on: exact paths, directory prefixes, and basename globs. */
function isPublished(relative, patterns, packageDir) {
	return patterns.some((pattern) => {
		const entry = pattern.replace(/^\.\//, "").replace(/\/$/, "");
		if (entry === relative) return true;
		if (relative.startsWith(`${entry}/`)) return fs.existsSync(path.join(packageDir, entry));
		if (!entry.includes("*")) return false;
		const source = entry
			.split("**")
			.map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
			.join(".*");
		const expression = new RegExp(`^${source}$`);
		return expression.test(entry.includes("/") ? relative : path.posix.basename(relative));
	});
}

/** Walks relative imports from the published entry points so a source file can never be left out of `files`. */
function checkPublishedImports(dir, pkg) {
	const packageDir = path.join(packagesDir, dir);
	const published = pkg.files ?? ["**"];
	const entries = (pkg.pi?.extensions ?? []).map((entry) => entry.replace(/^\.\//, ""));
	const pending = [...entries];
	const visited = new Set();
	while (pending.length > 0) {
		const relative = pending.pop();
		if (visited.has(relative)) continue;
		visited.add(relative);
		if (!isPublished(relative, published, packageDir))
			throw new Error(`${dir}: ${relative} is imported but missing from package.json files`);
		const source = fs.readFileSync(path.join(packageDir, relative), "utf8");
		for (const match of source.matchAll(RELATIVE_IMPORT)) {
			const target = path.posix.join(path.posix.dirname(relative), match[1]).replace(/\.js$/, ".ts");
			if (fs.existsSync(path.join(packageDir, target))) pending.push(target);
		}
	}
}

/** Skill-only packages: every declared skill root must hold a published SKILL.md whose `name` matches its directory. */
function checkSkillPackage(dir, pkg) {
	const packageDir = path.join(packagesDir, dir);
	const published = pkg.files ?? ["**"];
	for (const entry of pkg.pi.skills) {
		const skillDir = entry.replace(/^\.\//, "").replace(/\/$/, "");
		const relative = `${skillDir}/SKILL.md`;
		const file = path.join(packageDir, relative);
		if (!fs.existsSync(file)) throw new Error(`${dir}: ${relative} is missing`);
		if (!isPublished(relative, published, packageDir))
			throw new Error(`${dir}: ${relative} is missing from package.json files`);
		const frontmatter = fs.readFileSync(file, "utf8").match(/^---\n([\s\S]*?)\n---/);
		const name = frontmatter?.[1].match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1];
		if (name !== path.posix.basename(skillDir))
			throw new Error(`${dir}: ${relative} name "${name}" must match directory "${path.posix.basename(skillDir)}"`);
		if (!fs.existsSync(path.join(packageDir, skillDir, "references", "setup.md")))
			throw new Error(`${dir}: ${skillDir}/references/setup.md is required for first-time setup instructions`);
	}
}

for (const dir of packageDirs) {
	const pkgPath = path.join(packagesDir, dir, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	if (!pkg.name) throw new Error(`${dir}: missing name`);
	if (!pkg.version) throw new Error(`${dir}: missing version`);
	if (pkg.private === true) throw new Error(`${dir}: package is private=true (not publishable)`);
	if (pkg.pi?.skills && !pkg.pi.extensions) {
		checkSkillPackage(dir, pkg);
		process.stdout.write(`ok ${pkg.name}\n`);
		continue;
	}
	if (pkg.pi?.extensions?.[0] !== "./index.ts") throw new Error(`${dir}: pi.extensions must start with ./index.ts`);
	checkPublishedImports(dir, pkg);
	process.stdout.write(`ok ${pkg.name}\n`);
}
