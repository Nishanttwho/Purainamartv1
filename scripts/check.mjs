import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
export async function modules(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'tmp', 'dist', '.agents', '.codex'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await modules(file));
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) found.push(file);
  }
  return found.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const files = await modules(root);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Syntax failed: ${path.relative(root, file)}\n${result.stderr}`);
  }
  let imports = 0;
  for (const file of files.filter(file => file.startsWith(path.join(root, 'lib') + path.sep) || file === path.join(root, 'server.mjs'))) {
    await import(pathToFileURL(file)); imports++;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(lock.packages[''].dependencies)) throw new Error('package.json and lockfile dependencies differ.');
  if (Object.keys(lock.packages).some(name => /node_modules\/(?:pg(?:-|$)|postgres)/.test(name))) throw new Error('An obsolete database dependency remains in the lockfile.');
  console.log(JSON.stringify({ syntaxModules: files.length, apiAndLibraryImports: imports, dependencyManifest: 'consistent' }));
}
