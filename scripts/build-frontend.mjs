import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// The frontend is native HTML/CSS/ES modules. The production artifact is an
// exact, validated static copy; no transpiler or new dependency is required.
const root = path.resolve(import.meta.dirname, '..'), source = path.join(root, 'public');
const output = path.join(root, 'dist', 'public'), manifest = [];
async function build(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await build(file); continue; }
    if (!entry.isFile()) throw new Error('Unsupported frontend entry: ' + file);
    const relative = path.relative(source, file), data = await fs.readFile(file);
    if (/\.js$/.test(file)) {
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (check.status !== 0) throw new Error(check.stderr);
    }
    if (/\.html$/.test(file)) for (const match of data.toString().matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const reference = match[1].split(/[?#]/)[0];
      if (!reference || /^(?:https?:|data:|mailto:|tel:)/.test(reference) || !path.extname(reference)) continue;
      const target = reference.startsWith('/') ? path.join(source, reference) : path.resolve(path.dirname(file), reference);
      if (!target.startsWith(source + path.sep)) throw new Error('Frontend reference escapes public directory.');
      if (!(await fs.stat(target)).isFile()) throw new Error('Missing frontend asset: ' + reference);
    }
    const target = path.join(output, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    manifest.push({ path: relative.split(path.sep).join('/'), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
  }
}
await build(source);
await fs.writeFile(path.join(root, 'dist', 'frontend-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Frontend production build: ${manifest.length} files validated and copied to dist/public.`);
