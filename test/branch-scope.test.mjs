import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { branchTicketScope } from '../src/lifecycle-consumer.mjs';

const temporaryRoots = [];

function tempRepository(branchRef) {
  const root = join(tmpdir(), `acb-branch-scope-${randomUUID()}`);
  const work = join(root, 'worktree');
  mkdirSync(join(work, '.git'), { recursive: true });
  writeFileSync(join(work, '.git', 'HEAD'), `${branchRef}\n`, 'utf8');
  temporaryRoots.push(root);
  return work;
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('branch-derived ticket scope', () => {
  test('derives a ticket from a conventional feature branch', () => {
    const cwd = tempRepository('ref: refs/heads/feature/OC-18404-activity-tab');
    assert.deepEqual(branchTicketScope(cwd), { kind: 'ticket', key: 'OC-18404' });
  });

  test('refuses a branch that names two different tickets', () => {
    // Falling back from an ambiguous prompt must not land on an equally ambiguous branch
    // and quietly pick the first key; that injects context for the wrong task.
    const cwd = tempRepository('ref: refs/heads/feature/OC-1-and-OC-2');
    assert.equal(branchTicketScope(cwd), null);
  });

  test('accepts the same ticket repeated in a branch name', () => {
    const cwd = tempRepository('ref: refs/heads/feature/OC-7-followup-OC-7');
    assert.deepEqual(branchTicketScope(cwd), { kind: 'ticket', key: 'OC-7' });
  });

  test('finds the repository from a nested working directory', () => {
    const cwd = tempRepository('ref: refs/heads/bugfix/OC-19292-preserve-errors');
    const nested = join(cwd, 'src', 'areas', 'assets');
    mkdirSync(nested, { recursive: true });
    assert.deepEqual(branchTicketScope(nested), { kind: 'ticket', key: 'OC-19292' });
  });

  test('resolves a worktree whose .git is a gitdir pointer file', () => {
    const root = join(tmpdir(), `acb-branch-scope-${randomUUID()}`);
    const real = join(root, 'real-git');
    const work = join(root, 'worktree');
    mkdirSync(real, { recursive: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/feature/OC-20165-location-stats\n', 'utf8');
    writeFileSync(join(work, '.git'), `gitdir: ${real}\n`, 'utf8');
    temporaryRoots.push(root);
    assert.deepEqual(branchTicketScope(work), { kind: 'ticket', key: 'OC-20165' });
  });

  test('returns null for a branch without a ticket key', () => {
    assert.equal(branchTicketScope(tempRepository('ref: refs/heads/main')), null);
  });

  test('returns null for a detached HEAD', () => {
    assert.equal(
      branchTicketScope(tempRepository('9fceb02d0ae598e95dc970b74767f19372d61af8')),
      null
    );
  });

  test('fails soft on a missing or unusable path', () => {
    assert.equal(branchTicketScope(join(tmpdir(), `absent-${randomUUID()}`)), null);
    assert.equal(branchTicketScope(null), null);
    assert.equal(branchTicketScope(''), null);
  });
});
