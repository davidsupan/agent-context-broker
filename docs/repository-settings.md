# Repository settings

This file records the intended GitHub configuration. It is a recovery and drift
checklist; the live repository settings remain authoritative.

## Repository

- The default branch is `main`.
- Pull requests use squash merging. Merge commits and rebase merging are off.
- Pull request branch updates are suggested and merged head branches are deleted.
- Release immutability is enabled.
- Issues and Discussions are enabled. Discussions are the proposal and support
  channel; issues are for reproducible accepted-surface bugs.

## Branch protection

`main` requires:

- a pull request;
- an up-to-date branch;
- `test-linux`, `test-windows`, and `test-macos`;
- resolved conversations; and
- linear history.

The rule applies to administrators, and force pushes and branch deletion remain
disabled. Approval count and Code Owner approval are not required while the
project has one maintainer because the author cannot approve their own pull
request.

## Actions

- Workflow permissions are read-only for repository contents and packages.
- Actions cannot create or approve pull requests.
- First-time external contributors require workflow approval.
- Every third-party action reference is pinned to a full commit SHA.

After the SHA-pinned CI workflow reaches `main`, enable GitHub's repository-wide
"Require actions to be pinned to a full-length commit SHA" policy. Enabling it
before the pinned workflow lands can block otherwise valid runs from the current
default branch.

## Pages

- GitHub Pages deploys from the `Pages` GitHub Actions workflow.
- The workflow publishes the dependency-free files under `site/` only.
- The project URL is `https://davidsupan.github.io/agent-context-broker/`.
- The site uses no analytics, cookies, third-party fonts, scripts, or images.
- Pages actions are pinned to full commit SHAs and receive only `contents: read`,
  `pages: write`, and `id-token: write` permissions.

## Security

- Private vulnerability reporting, dependency graph, Dependabot alerts, malware
  alerts, security updates, and grouped security updates are enabled.
- Secret scanning and push protection are enabled.
- CodeQL default setup scans JavaScript/TypeScript and GitHub Actions.

After the first successful CodeQL scan is visible as a stable pull request check,
add it to the protected-branch requirements. Do not require a check before its
name and successful execution are confirmed.

## Review cadence

Review this baseline after provider support, release automation, or Pages
deployment changes, or when GitHub deprecates a configured control. Also review
it before each public release and update this document in the same pull request
as any intentional policy change.
