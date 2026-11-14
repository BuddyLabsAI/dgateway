import { test, expect } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname, join } from 'node:path';

async function files(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!['console-web', 'docs-web', 'node_modules'].includes(entry.name))
        found.push(...(await files(`${dir}/${entry.name}`)));
    } else if (entry.name.endsWith('.ts')) found.push(`${dir}/${entry.name}`);
  }
  return found;
}

test('functional core and package dependency boundaries', async () => {
  const root = resolve('src');
  const paths = await files(root);
  for (const path of paths) {
    if (path.includes('/console-web/')) continue;
    const text = await readFile(path, 'utf8');
    if (/\/(functions|schemas)\//.test(path)) {
      expect(text, relative(root, path)).not.toMatch(
        /\bfetch\s*\(|bun:sqlite|node:fs|Date\.now\s*\(|Math\.random\s*\(|process\.env/,
      );
      for (const m of text.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)/g)) {
        const dest = resolve(dirname(path), m[1]);
        expect(dest, relative(root, path)).not.toMatch(/\/(effects|providers)\//);
      }
    }
    if (path.includes('/packages/'))
      for (const m of text.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)/g)) {
        expect(resolve(dirname(path), m[1]), relative(root, path)).not.toContain('/modules/');
      }
  }
});

test('docs-web is an independent static app with no backend or console imports', async () => {
  const app = resolve('src/modules/gateway/apps/docs-web');
  const config = await readFile(join(app, 'next.config.mjs'), 'utf8');
  expect(config).toContain("output: 'export'");
  expect(await readFile(join(app, 'package.json'), 'utf8')).toContain('dgateway-docs-web');
  const glob = new Bun.Glob('**/*.{ts,tsx}');
  for await (const path of glob.scan({ cwd: app })) {
    if (/^(node_modules|\.next|\.source|out|snippets)\//.test(path)) continue;
    expect(path).not.toMatch(/(^|\/)route\.tsx?$/);
    const text = await readFile(join(app, path), 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)/g)) {
      const specifier = match[1];
      expect(specifier).not.toMatch(/modules|console-web|gateway-daemon/);
      if (!specifier.startsWith('.')) continue;
      const destination = relative(app, resolve(app, dirname(path), specifier));
      expect(destination, path).not.toStartWith('..');
    }
  }
});
