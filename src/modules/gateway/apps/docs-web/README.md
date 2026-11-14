# dgateway docs

The dgateway documentation site. It is a Fumadocs app on Next.js that exports static files; the site has no runtime API routes.

## Develop

```sh
bun install
bun run dev
```

`bun run build` uses webpack and exports the site to `out/`. `bun run types:check` type-checks the app. Before dev and build, `scripts/search-index.mjs` writes a Fumadocs static search database to `public/search-index.json`.

## Content

Pages are under `content/docs`, and each section's `meta.json` sets its navigation. Examples are in `snippets`. Include one in a page with `<include cwd lang="sh">snippets/decisions.sh</include>` (or `lang="ts"`). Root integration tests run every snippet against a temporary server that uses the seeded mock provider.

## Checks

Root Prettier checks this app's sources. This app has its own Next.js/MDX toolchain, so root ESLint skips it. Root checks still type-check and lint the snippet integration tests. The docs build runs its own TypeScript check.

## Deploy

Deploy `out/` to a static host with directory index support. The GitHub Pages workflow builds with `DOCS_BASE_PATH=/dgateway` and deploys the resulting `out/` directory. Without `DOCS_BASE_PATH`, local development and static exports use the root path.

## Origin

Created from `create-fumadocs-app` static template 0.0.59. Next.js and Fumadocs versions remain pinned as generated. Local font files and their licenses are copied from the console design assets.
