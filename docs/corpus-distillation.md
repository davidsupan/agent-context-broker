# Corpus distillation

The distillation module turns your own local Claude Code sessions into candidate claims for your broker memory. It runs on the device where the sessions are, once a day within a time budget. What it finds goes into a review queue. Nothing becomes accepted context until you review it. Raw transcripts never leave the device: the model sees redacted slices only, and the queue, results and receipts stay under the runtime home.

Every device distils its own sessions. Each needs its own runtime home and its own approval.

## Turn it on

The commands below use the installed tool. Replace `<tool>` with `~/.agent-context-broker/tool` (or `%USERPROFILE%\.agent-context-broker\tool`) and `<home>` with an absolute folder for the distillation runtime.

Preview the plan. This writes nothing:

```sh
node <tool>/distillation/src/cli.mjs enable --home <home>
```

The plan lists:
- the sources found, as counts only;
- the daily budget (default 1800 seconds; `--daily-seconds` sets 60–7200);
- the Claude Code executable it will use, with its size and SHA-256;
- the schedule;
- the files it will write;
- a `planDigest`.

The executable is found in this order:
1. `--claude-cli` if given.
2. The native installer's location: `~/.local/bin`, and on Windows also `%LOCALAPPDATA%\Programs\claude`.
3. Homebrew (`/opt/homebrew/bin`) and `/usr/local/bin`.
4. A global npm install's executable.

PATH and shell shims are never used.

Apply exactly that plan, with the same options and the consent phrase:

```sh
node <tool>/distillation/src/cli.mjs enable --home <home> --execute --plan-digest <digest> --consent "distill my sessions on this device"
```

A changed plan is refused. Rerun the preview and approve the new digest. The schedule is a per-user LaunchAgent on macOS and a scheduled task on Windows. Both run daily at 09:15 local time by default (`--schedule-time`).

A local export of older Cowork history can be imported once with `--cowork-export <file> --sources code,cowork-import`. It is off by default.

## Before the first run

A live run needs an approved provider profile for this device:
- a capability receipt;
- a human-reviewed live-profile receipt bound to this runtime home, executable and environment.

Until then, runs stop with `live-profile-receipt-required` and nothing is sent to a model. After a Claude Code upgrade the executable hash changes, and runs stop with `provider-executable-changed` until the profile is approved again.

On Windows a live run goes through the contained launcher:
- the model CLI starts with exactly the allow-listed environment;
- it runs inside a job object that ends its whole process tree;
- cleanup is certified only when the job has no processes left.

The guarantee covers lifetime and environment for cooperative processes. It is not a sandbox against a hostile process running as the same user.

## Day to day

```sh
node <tool>/distillation/src/cli.mjs status --home <home>
node <tool>/distillation/src/cli.mjs review count --home <home>
node <tool>/distillation/src/cli.mjs review list --home <home>
node <tool>/distillation/src/cli.mjs run --once --home <home>
```

`run --once` and the scheduled run share their guards: one run per UTC day, a lock, and the budget. Each run writes a receipt `runs/<runId>.json`.

| Exit | Meaning |
|---|---|
| 0 | Done |
| 2 | Nothing to do: disabled, already ran today, lock held, or budget exhausted |
| 3 | Integrity or containment failure: a hard stop, not retried |
| 4 | Quota wait until the next day |
| 1 | Anything else, including a provider profile that needs approval |

## Turn it off

```sh
node <tool>/distillation/src/cli.mjs disable --home <home> --execute
```

This removes the schedule and marks the configuration disabled. The queue, results and receipts stay.
