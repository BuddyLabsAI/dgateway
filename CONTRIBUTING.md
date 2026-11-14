# Contributing

You need Bun 1.3. Install dependencies at the repository root and in each web app (the console and the docs site):

```sh
bun install
(cd src/modules/gateway/apps/console-web && bun install)
(cd src/modules/gateway/apps/docs-web && bun install)
```

Before you submit a change, run both checks from the root:

```sh
bun run check
bun run docs:check
```

`bun run check` runs Prettier, ESLint, the TypeScript compiler and the tests in `tests/`. `bun run docs:check` type-checks the docs site. `bun run format` fixes formatting, and `bun run lint:fix` applies ESLint's automatic fixes. The console's tests are in `tests/unit/console-web`. To run only those, use `bun run test` in `src/modules/gateway/apps/console-web`.

## Commit messages

Commit headers follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) with a [gitmoji](https://gitmoji.dev/) at the start of the subject:

```text
type(scope)!: <emoji> subject
```

For example, `feat(console): ✨ add route search` or `fix: 🐛 reject empty question lists`. The scope is optional and uses lowercase letters, digits and hyphens. The header is at most 100 characters. Leave a blank line between the header and the body. The emoji goes after the colon, so release tools still read the type.

| Type       | Emoji | Use it for                                  |
| ---------- | ----- | ------------------------------------------- |
| `feat`     | ✨    | A new feature                               |
| `fix`      | 🐛    | A bug fix                                   |
| `docs`     | 📝    | Documentation only                          |
| `style`    | 💄    | Formatting that does not change behavior    |
| `refactor` | ♻️    | A code change that is not a fix or feature  |
| `perf`     | ⚡️    | A performance improvement                   |
| `test`     | ✅    | Tests                                       |
| `build`    | 📦️    | The build, the Docker image or dependencies |
| `ci`       | 👷    | CI workflows                                |
| `chore`    | 🔧    | Other maintenance                           |
| `revert`   | ⏪️    | Reverting an earlier commit                 |

Mark a breaking change with `!` after the type or scope, such as `feat(api)!: ✨ rename cost to cost_usd`, or with a `BREAKING CHANGE: <description>` footer in the body.

`bun install` at the root turns on the commit-msg hook in `.githooks`: it runs `git config core.hooksPath .githooks`. The hook adds a missing emoji for you, then checks the message and stops the commit if it is invalid. It allows `fixup!` and `squash!` commits. To check a message yourself, run `bun scripts/commit-msg.ts --message "feat: ✨ add route search"`. CI checks every commit of a pull request and the pull request title, with no automatic fixes and no `fixup!` or `squash!` commits. Git's own `Merge ...` and `Revert "..."` headers pass without an emoji. If you squash a pull request, its title becomes the commit header, so give it the same form.

## Releases

[release-please](https://github.com/googleapis/release-please) reads the commit headers on `main` and keeps a release pull request open with the next version and the new `CHANGELOG.md` entry. To release, merge that pull request. Merging tags the commit (for example `v0.2.0`), publishes a GitHub release and starts the Docker image build, which pushes `ghcr.io/buddylabsai/dgateway` with the tags `0.2.0`, `0.2` and `latest`. Every push to `main` also pushes the `edge` and `sha-<commit>` image tags.

Before 1.0.0, versions change like this: `feat` commits and breaking changes raise the minor version (0.1.0 to 0.2.0), and `fix`, `perf`, `revert` and `docs` commits raise the patch version (0.1.0 to 0.1.1). Commits with other types appear in no changelog section, and unless they are marked as breaking, they alone do not start a release. After 1.0.0, a breaking change raises the major version.
