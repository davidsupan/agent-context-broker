# Releasing

GitHub Releases are the canonical release history. The project does not keep a
second hand-maintained changelog.

## Release checklist

1. Start from an exact, green `main` commit.
2. Update the root and provider package versions together.
3. Update version references in documentation, examples, and `site/index.html`.
4. Run `bun run validate` on a supported platform.
5. Run `bun pm pack --dry-run` and inspect the allowlisted package contents.
6. Create the package archive with `bun pm pack` and record its SHA-256 digest.
7. Tag the exact commit as `v<package-version>` and create a GitHub Release.
   Generate the initial notes from `.github/release.yml`, then review them for
   compatibility, security, and migration details before publishing. A release
   that changes what an artifact may contain says so in the notes: an artifact
   carrying a caller descriptor is unreadable to a reader older than the release
   that added the `agent` field, and such a reader fails the whole read rather
   than skipping that artifact. State also that
   `AGENT_CONTEXT_BROKER_DESCRIPTORS` gates the descriptor flags in the launcher
   only; the library and `src/cli.mjs` do not enforce it, so another wrapper must
   make the same check itself.
8. Mark beta versions as prereleases and attach the archive plus checksum when
   distributing an installable package.
9. Verify the tag, release target, archive digest, and release notes after
   publication.

Do not publish from a dirty worktree or from a commit that has not passed all
required platform jobs. Never include runtime state, provider histories,
credentials, personal paths, or private integration configuration in a release.

Release immutability should remain enabled once the first public prerelease is
published. A broken release is superseded by a new version rather than silently
replacing its tag or assets.
