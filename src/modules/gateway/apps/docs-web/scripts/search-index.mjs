import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { initSimpleSearch } from 'fumadocs-core/search/server';

async function pages(folder = 'content/docs') {
  const entries = await readdir(folder, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = `${folder}/${entry.name}`;
      if (entry.isDirectory()) return pages(path);
      if (!entry.name.endsWith('.mdx')) return [];
      const text = await readFile(path, 'utf8');
      const title = /^title: (.+)$/m.exec(text)?.[1] ?? entry.name;
      const description = /^description: (.+)$/m.exec(text)?.[1] ?? '';
      const slug = path
        .replace('content/docs/', '')
        .replace(/\.mdx$/, '')
        .replace(/(^|\/)index$/, '');
      return [
        { title, description, content: text.replace(/^---[\s\S]*?---/, ''), url: `/docs/${slug}` },
      ];
    }),
  );
  return nested.flat();
}

const indexes = await pages();
const search = initSimpleSearch({ indexes, language: 'english' });
await mkdir('public', { recursive: true });
await writeFile('public/search-index.json', JSON.stringify(await search.export()));
console.log(`Exported static search index: ${indexes.length} pages`);
