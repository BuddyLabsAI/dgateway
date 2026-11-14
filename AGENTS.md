# Project instructions

Code lives in modules (`src/modules/<name>`) and independent packages (`src/packages`). Apps are named `<name>-<type>`, with type `web`, `daemon`, `cli` or `mobile`, such as `console-web` and `gateway-daemon`.

Dependencies follow these rules:

- Packages never import module code, have no dependency cycles and keep stable public interfaces.
- A module never imports another module's code.
- `libs/` never imports `api/` or `apps/`.
- `functions/` and `schemas/` stay pure and never import `effects/` or `providers/`. Pure functions return the same result for the same inputs and keep no mutable shared state.

Prefer pure functions over effects. Effects do not depend on REST request objects or other transport contexts. They gather inputs, let pure functions decide, then perform calls and writes:

```ts
const inputs = gatherInputs();
const decision = decidePurely(inputs);
performEffects(decision);
```

Put tests under root `tests/`; test pure functions without mocks. Run `bun run check` before finishing changes; `bun run format` fixes formatting and `bun run lint` runs ESLint. The reference pages in `src/modules/gateway/apps/docs-web/content/docs/reference/` and the tests are the source of truth for endpoint behavior.

## Conventions

- Separate functions with a blank line (enforced by lint).
- Write commit headers as Conventional Commits with the type's gitmoji after the colon, such as `feat(console): ✨ add route search`. CONTRIBUTING.md lists the types and their emoji.
- The console is a separately bundled browser app: its files import only from their own folder and reach the backend over HTTP. Its tests live in `tests/unit/console-web/`.

- The documentation is a separate static Fumadocs app in `src/modules/gateway/apps/docs-web`, with its own package, tsconfig and build. It imports no backend or console code. Its runnable snippets show the HTTP API and the independent decision-client package; they are not bundled into the site. Root checks verify the formatting of documentation sources and test the snippets over HTTP. `bun run docs:check` and the docs build type-check the docs TypeScript, and root ESLint explicitly excludes it.
