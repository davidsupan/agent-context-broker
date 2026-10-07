# Contributing

Agent Context Broker is an open-source beta with a curated, proposal-first contribution process. Starting with a clear report or design conversation helps keep the provider-neutral contracts focused and gives maintainers a chance to confirm scope before implementation.

By participating, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
Project decisions follow the maintainer-led process in [GOVERNANCE.md](GOVERNANCE.md),
and usage questions belong in the channels described by [SUPPORT.md](SUPPORT.md).

## Start with a report or proposal

Use the [GitHub issue tracker](https://github.com/davidsupan/agent-context-broker/issues) or a GitHub Discussion to share:

- bug reports with expected and actual behavior;
- design discussions about provider-neutral contracts or workflows; and
- focused reproductions with the smallest useful fixture or test case.

When possible, include the package version or commit, provider, operating system, Node (or Bun) version, minimal reproduction steps, and the behavior you expected. Redact sensitive values and prefer synthetic fixtures.

## Pull request policy

To keep the beta focused, unsolicited pull requests are not generally accepted. A pull request is welcome only when a maintainer has explicitly accepted its scope and it:

- fixes a previously reported and accepted bug; or
- implements a feature explicitly discussed and accepted for integration in a GitHub Discussion or issue.

Before opening a PR, link the relevant accepted Discussion or issue and keep the patch narrowly scoped. If no proposal exists yet, open one first and wait for maintainers to confirm that the change is accepted for integration.

## Change expectations

- Keep changes provider-neutral and avoid organization-specific identifiers or private integration details.
- Add or update deterministic tests for behavioral changes.
- Describe security, privacy, compatibility, or migration impact when it matters.
- Keep fixtures and examples minimal, synthetic, and easy to reproduce.

By submitting a contribution, you confirm that you have the right to submit it
and agree that it is licensed under the repository's Apache License 2.0.

## Validate locally

Run both package validation commands before opening a PR:

```sh
npm run validate
npm pack --dry-run
```

Type-check the JavaScript sources with `tsc --checkJs`. The check fails only on errors that `typecheck-baseline.json` does not already hold:

```sh
npm ci --ignore-scripts
npm run typecheck
```

When you fix a known error, shrink the baseline with `node scripts/check-types.mjs --update`. The update is refused while any error is new, so the baseline can only shrink.

## TypeScript sources

The sources are moving from JavaScript (`.mjs`) to TypeScript (`.mts`) one module at a time. The rules:

- A migrated module is `name.mts` beside where `name.mjs` was, renamed with `git mv`. Importers name it with its real extension, `./name.mts`.
- Only erasable syntax is allowed (`erasableSyntaxOnly`): types, interfaces and `import type`. No enums, no namespaces and no parameter properties, because Node and Bun run the sources by stripping types.
- A `.mts` file must be clean under `strict`. The baseline never holds an error in one.
- A file that the runtime names by path stays a thin `.mjs` entry point that imports its `.mts` logic. That covers `src/cli.mjs`, the provider bridges and CLIs, the scripts the launchers and installer start, and the required files in `scripts/check-package.mjs`.
- The package ships JavaScript only. `npm run build` stages `build/package`, strips every `.mts` to `.mjs` with line numbers kept, and rewrites the imports. Release with `npm run pack:package`, never with a plain `npm pack` of the source tree.
- Tests stay `.mjs` and run against the sources. The `test-package` job runs the same tests against the staged package.

## Keep data safe

Do not include real transcripts, credentials, secrets, personal paths, internal URLs, proprietary ticket data, or private organizational data in issues, fixtures, documentation, or pull requests. For suspected vulnerabilities, follow [`SECURITY.md`](SECURITY.md) and report them privately rather than publishing sensitive details.
