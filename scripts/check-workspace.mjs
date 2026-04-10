import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packagesDir = path.join(root, 'packages');
const packageDirs = fs.readdirSync(packagesDir).filter((name) => fs.existsSync(path.join(packagesDir, name, 'package.json')));

for (const dir of packageDirs) {
  const pkgPath = path.join(packagesDir, dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg.name) throw new Error(`${dir}: missing name`);
  if (!pkg.version) throw new Error(`${dir}: missing version`);
  if (pkg.private === true) throw new Error(`${dir}: package is private=true (not publishable)`);
  if (pkg.pi?.extensions?.[0] !== './index.ts') throw new Error(`${dir}: pi.extensions must start with ./index.ts`);
  console.log(`ok ${pkg.name}`);
}
