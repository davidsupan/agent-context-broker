import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { reviewLedgerContext } from '../src/work-ledgers.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-work-ledgers-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('work ledgers', () => {
  test('supports raw GitLab, structured review, and legacy summary identities', () => {
    const ledgers = root('formats');
    const raw = join(ledgers, 'mr-8466');
    const structured = join(ledgers, 'mr-8411');
    const legacy = join(ledgers, 'mr-7685');
    for (const directory of [raw, structured, legacy]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(raw, 'mr.json'), `${JSON.stringify({
      iid: 8466,
      references: { full: 'acme/widgets!8466' },
      title: 'APP-19979 and APP-19980 review'
    })}\n`, 'utf8');
    writeFileSync(join(structured, 'metadata.json'), `${JSON.stringify({
      schemaVersion: 1,
      mergeRequest: 8411,
      project: 'acme/widgets',
      issue: 'APP-19666'
    })}\n`, 'utf8');
    writeFileSync(join(legacy, 'REVIEW_PACKAGE.md'), [
      '# MR !7685 Review Package',
      'MR: https://gitlab.example.com/acme/widgets/-/merge_requests/7685',
      'Ticket: APP-18028'
    ].join('\n'), 'utf8');

    assert.deepEqual(reviewLedgerContext(ledgers, 'acme/widgets!8466').ticketKeys, ['APP-19979', 'APP-19980']);
    assert.deepEqual(reviewLedgerContext(ledgers, 'acme/widgets!8411').ticketKeys, ['APP-19666']);
    assert.deepEqual(reviewLedgerContext(ledgers, 'acme/widgets!7685').ticketKeys, ['APP-18028']);
  });

  test('fails closed when a configured review ledger cannot prove its identity', () => {
    const ledgers = root('invalid');
    const directory = join(ledgers, 'mr-8466');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify({
      iid: 9999,
      references: { full: 'acme/widgets!9999' }
    })}\n`, 'utf8');

    assert.throws(
      () => reviewLedgerContext(ledgers, 'acme/widgets!8466', { required: true }),
      /identity is missing/u
    );
  });
});
