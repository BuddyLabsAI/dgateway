// Production build: bundles index.html and everything it references into dist/.
// The emitted index.html uses relative asset URLs, so dist/ works when served at "/".
// NODE_ENV is defined as "production", so React and the other libraries ship their production
// builds. No other environment value is inlined, so the bundle never carries developer values.
// Fonts stay files: Bun would inline every url() in CSS as base64, so .woff2 is marked external
// (the CSS keeps "./fonts/…") and the files are copied to dist/fonts beside the stylesheet.
// The dev script (bun --hot ./index.html) does not run this file and keeps development mode.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { relative } from "node:path";

const projectRoot = import.meta.dir;
const outdir = `${projectRoot}/dist`;
const fontsSource = `${projectRoot}/src/styles/fonts`;

await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [`${projectRoot}/index.html`],
  outdir,
  minify: true,
  // Code splitting puts the dynamically imported mock API (and its fixtures) in their own chunk.
  splitting: true,
  // Selects React's production build. Without it the bundle carries the development build.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  external: ["*.woff2"],
  sourcemap: "none",
  target: "browser",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if (!existsSync(`${outdir}/index.html`)) {
  console.error("build did not produce dist/index.html");
  process.exit(1);
}

await mkdir(`${outdir}/fonts`, { recursive: true });
const fonts = (await readdir(fontsSource)).filter((name) => name.endsWith(".woff2"));
for (const name of fonts) await copyFile(`${fontsSource}/${name}`, `${outdir}/fonts/${name}`);

for (const output of result.outputs) {
  const name = relative(projectRoot, output.path);
  console.log(`${name}  ${(output.size / 1024).toFixed(1)} kB`);
}

for (const name of fonts) {
  const size = Bun.file(`${outdir}/fonts/${name}`).size;
  console.log(`dist/fonts/${name}  ${(size / 1024).toFixed(1)} kB`);
}
