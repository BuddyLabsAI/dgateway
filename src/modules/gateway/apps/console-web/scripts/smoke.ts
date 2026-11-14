// Browser-free smoke check of the production build. It serves dist/ at "/" with the
// same SPA fallback the daemon uses, then fetches index.html, every asset it references,
// and every chunk those scripts import. The mock API is imported lazily (mock mode only),
// so it is one of those chunks. The check fails unless each file answers 200, the entry
// script carries no mock fixtures, and a chunk that does is loaded by import() from the entry.

import { existsSync } from "node:fs";

// A string that only the mock API's fixtures contain.
const MOCK_FIXTURE = "Baseten Elephant via OpenRouter";

const dist = `${import.meta.dir}/../dist`;
if (!existsSync(`${dist}/index.html`)) {
  console.error("dist/index.html is missing. Run `bun run build` first.");
  process.exit(1);
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = Bun.file(`${dist}${pathname === "/" ? "/index.html" : pathname}`);
    if (pathname !== "/" && (await file.exists())) return new Response(file);
    if (pathname.startsWith("/admin/") || pathname.startsWith("/v1/")) {
      return new Response("not served by the smoke server", { status: 404 });
    }
    return new Response(Bun.file(`${dist}/index.html`), { headers: { "Content-Type": "text/html" } });
  },
});

const base = `http://127.0.0.1:${server.port}`;
let failures = 0;
const visited = new Set<string>();
const dynamicImports = new Set<string>();
const chunksWithMock = new Set<string>();

async function check(reference: string, url: URL): Promise<string | null> {
  const response = await fetch(url);
  const body = response.status === 200 ? await response.text() : "";
  console.log(`${response.status}  ${reference}`);
  if (response.status !== 200) {
    failures += 1;
    return null;
  }
  return body;
}

// Chunks are named as quoted relative paths ("./chunk-….js") in the script that imports them.
async function followChunks(from: URL, body: string): Promise<void> {
  for (const match of body.matchAll(/["'`](\.\/[^"'`\s]+\.js)["'`]/g)) {
    const reference = match[1] ?? "";
    const url = new URL(reference, from);
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const chunk = await check(reference, url);
    if (chunk === null) continue;
    if (chunk.includes(MOCK_FIXTURE)) chunksWithMock.add(reference);
    await followChunks(url, chunk);
  }
}

try {
  const page = await check("/ (index.html)", new URL("/", base));
  if (page === null) throw new Error("index.html did not load");

  const references = new Set<string>();
  for (const match of page.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (value && !value.startsWith("data:") && !value.startsWith("#")) references.add(value);
  }
  if (references.size === 0) throw new Error("index.html references no assets");

  for (const reference of references) {
    const url = new URL(reference, `${base}/`);
    const body = await check(reference, url);
    if (body === null) continue;
    if (reference.endsWith(".css")) {
      for (const match of body.matchAll(/url\(([^)]+)\)/g)) {
        const target = (match[1] ?? "").replace(/["']/g, "");
        if (target.startsWith("data:") || target.length === 0) continue;
        await check(`  (css) ${target}`, new URL(target, url));
      }
    }
    if (reference.endsWith(".js")) {
      if (body.includes(MOCK_FIXTURE)) throw new Error(`${reference} carries mock fixtures`);
      for (const match of body.matchAll(/import\("(\.\/[^"]+\.js)"\)/g)) dynamicImports.add(match[1] ?? "");
      visited.add(url.href);
      await followChunks(url, body);
    }
  }

  const lazyMock = [...dynamicImports].filter((reference) => chunksWithMock.has(reference));
  if (lazyMock.length === 0) {
    throw new Error("the mock fixtures are not in a chunk that the entry script loads with import()");
  }
  console.log(`mock chunk ${lazyMock.join(", ")} is loaded with import() and answers 200`);

  const served = await fetch(new URL("/some/deep/route", base));
  console.log(`${served.status}  /some/deep/route (SPA fallback)`);
  if (served.status !== 200) failures += 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  failures += 1;
} finally {
  await server.stop(true);
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all assets resolved");
