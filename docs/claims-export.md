# Claims export

`claims-export` gives a host application the accepted, hash-verified claims for a set of scopes, so the host can seal them into its own snapshot. One example is a desktop assistant that builds a "settled decisions" file at refresh time. The command is read-only. It never ranks by relevance, and it never returns pending, rejected or superseded claims.

```sh
agent-context-broker capabilities --json
agent-context-broker claims-export --provider claude-code --home "$AGENT_CONTEXT_BROKER_HOME" \
  --scope ticket:PROJ-123 --scope merge-request:group/app!42 \
  --ref https://www.figma.com/design/<fileKey> --include-project <project> --limit 200 --json
```

## Options

| Option | Meaning |
|---|---|
| `--provider` | `codex` or `claude-code`. Private claims come back only for the provider that recorded them. |
| `--home` | The runtime home. The reconciliation and event roots are derived the way the installed launcher derives them, including its environment overrides. |
| `--runtime-root`, `--event-runtime-root` | Explicit roots, instead of `--home` |
| `--scope kind:key` | Repeatable. The kinds are `global`, `project`, `workstream`, `ticket` and `merge-request`. |
| `--ref prefix` | Repeatable. It matches a claim's `canonicalRefs` by prefix, ignoring the query and fragment on both sides. A requested Figma URL that names a `node-id` narrows the match to that node, with `-` and `:` treated as the same. |
| `--include-project key` | Adds the project-wide claims |
| `--after cursor`, `--limit n` | Paging: 200 per page by default, at most 500, ordered by `acceptedAt`, then `claimKey` |
| `--provider-policy path` | The same provider policy as for queries: read rules and strict isolation apply |

## Output

```json
{
  "schemaVersion": 1,
  "broker": { "version": "0.12.0", "headHash": "<sha256>", "eventCount": 7313 },
  "records": [{
    "claimKey": "design.button-colour", "claimId": "<sha256>", "claimType": "decision",
    "subject": "portal", "predicate": "decides", "value": "primary buttons use the brand blue", "valueHash": "<sha256>",
    "statement": "portal — decides: primary buttons use the brand blue",
    "observedAt": "2026-10-07T09:00:00.000Z", "acceptedAt": "2026-10-07T09:00:00.000Z", "confidence": 1,
    "sensitivity": "shared", "freshness": "current", "scope": { "kind": "project", "key": "example" },
    "supersedes": null, "canonicalRefs": ["https://example.org/spec"],
    "acceptance": { "acceptedAt": "2026-10-07T09:00:00.000Z", "providers": ["claude-code"] }
  }],
  "truncated": false, "nextCursor": null, "warnings": []
}
```

- `statement` is "subject — predicate: value", with whitespace collapsed, at most 600 characters.
- A claim another returned claim supersedes is left out.
- Native session ids and provenance hashes never leave the broker.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success; the JSON is on stdout |
| 2 | Usage error |
| 3 | Integrity failure: the event store head, the accepted registry, a snapshot or a claim did not verify. Nothing is printed to stdout; the caller seals nothing from the broker and does not retry. |
| 4 | The provider policy is invalid, so the command fails closed |

A broker older than this command has no `capabilities` command. Treat any non-zero exit from `capabilities` as "unsupported".
