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

When possible, include the package version or commit, provider, operating system, Bun version, minimal reproduction steps, and the behavior you expected. Redact sensitive values and prefer synthetic fixtures.

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
bun run validate
bun pm pack --dry-run
```

## Keep data safe

Do not include real transcripts, credentials, secrets, personal paths, internal URLs, proprietary ticket data, or private organizational data in issues, fixtures, documentation, or pull requests. For suspected vulnerabilities, follow [`SECURITY.md`](SECURITY.md) and report them privately rather than publishing sensitive details.
