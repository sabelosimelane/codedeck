import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'logs']);

function productionSources(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...productionSources(path.join(dir, entry.name)));
    } else if (/\.(m?js)$/.test(entry.name) && !/\.test\.m?js$/.test(entry.name) && entry.name !== 'vitest.config.js') {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const SPECIFIER_PATTERNS = [
  /^\s*(?:(?:import|export)\b[^\n]*|\}[^\n]*)\bfrom\s+['"]([^'"]+)['"]/gm,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\.meta\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire(?:\.resolve)?\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importedPackages(source) {
  const packages = new Set();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;
      const name = packageName(specifier);
      if (builtinModules.includes(name)) continue;
      packages.add(name);
    }
  }
  return packages;
}

describe('server dependencies', () => {
  it('declares every package that server production code imports directly', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const undeclared = [];
    for (const file of productionSources(serverDir)) {
      for (const name of importedPackages(fs.readFileSync(file, 'utf8'))) {
        if (!declared.has(name)) undeclared.push(`${name} (${path.relative(serverDir, file)})`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
