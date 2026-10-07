# Provider policy

By default every installed provider reads and publishes context under the same rules. A provider policy lets an operator narrow that per provider. For example, one provider can be a research-only contributor that publishes into an inbox scope and reads nothing else.

The policy is optional. Without the file, nothing changes.

## Where the broker looks

1. `--provider-policy <path>` on the `context-query`, `context-publish`, `progress-publish` and `doctor` commands.
2. `AGENT_CONTEXT_BROKER_PROVIDER_POLICY`.
3. `<runtime home>/provider-policy.json`. The installer writes it here when given `--provider-policy <file>`.

The policy belongs to the store a command works on. When a command is given `--runtime-root` or `--event-runtime-root` in the standard `<runtime home>/runtime/<store>` layout, step 3 uses that runtime home. Explicit roots outside one standard home inherit no policy, unless step 1 or 2 names one. Without explicit roots, the default runtime home (`AGENT_CONTEXT_BROKER_HOME` or the platform default) is used.

The installer validates the file, then plans, backs up and verifies it like any other target. `remove` and `rollback` restore the state that existed before the install.

`doctor` reports a bounded summary: the hash, plus rule counts per provider.

A file that is present but invalid fails closed:
- the hook bridges withhold context and record `provider-policy-invalid` in the audit;
- the commands stop with `Provider policy is invalid.`

## Format

The JSON schema is `schemas/provider-policy.schema.json`. Example:

```json
{
  "schemaVersion": 1,
  "providers": {
    "codex": {
      "defaultProject": null,
      "read": { "allow": ["workstream:research-*"], "deny": ["workstream:research-private"] },
      "publish": {
        "allow": ["workstream:research-inbox"],
        "maxSensitivity": "private",
        "evidenceClasses": ["agent-handoff"]
      }
    }
  }
}
```

**Patterns** take the form `<kind>:<key glob>`:
- `kind` is `global`, `project`, `workstream`, `ticket`, `merge-request` or `*`.
- Key globs match case-insensitively, and `*` matches any characters.
- `deny` always wins.
- When `allow` is present, it is an allow-list: a scope that it does not name stays unreadable, or unpublishable, until the operator adds it.

**Read rules**:
- They apply to hook advisories (peer progress and accepted-context references), to `context-query` and to peer-progress reads.
- A provider with read rules gets no related-scope expansion, because related scopes are stored as hashes and cannot be matched against patterns.
- An ambient project is dropped when it is not readable.
- An ambient global scope is dropped when the read rules do not allow it.

**Publish rules** are checked against the provider bound to the attested source token, before anything is written.

**`strictIsolation: true`** does for one provider what `AGENT_CONTEXT_BROKER_STRICT_ISOLATION=1` does for all of them.

## What it is not

The hook bridges know which provider they serve, and publication binds the provider to the source token. A provider named on the command line of a query is a declaration, not an authentication. The policy is therefore a guardrail for cooperating agents, not a sandbox: anything with file access to the runtime home can read the store directly.
