import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import { NOTICE_ID } from './notice-guard.mjs';

const sha = z.string().regex(/^[a-f0-9]{40,64}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.number().int().positive();
const username = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u);
// Pinned local implementation of the protected CI artifact's closed v1 schema.
const approvalsSchema = z.strictObject({
  schemaVersion: z.literal(1), projectId: id, commit: sha,
  notices: z.array(z.strictObject({
    recordId: z.string().regex(NOTICE_ID), contentDigest: digest,
    mergeRequest: z.strictObject({ iid: id }),
    approvers: z.array(username).min(1).max(100).refine((v) => new Set(v).size === v.length),
    mergedAt: z.iso.datetime(), pipeline: z.strictObject({ id })
  })).max(256)
}).refine((v) => new Set(v.notices.map((n) => n.recordId)).size === v.notices.length);
const trustSchema = z.strictObject({
  schemaVersion: z.literal(1), repository: z.string().min(1).max(4096),
  artifactDigest: digest, projectId: id, commit: sha, pipelineId: id,
  verified: z.literal(true), protectedRef: z.literal(true), status: z.literal('success'),
  ref: z.string().min(1).max(200), jobName: z.literal('approval-receipts')
});

/** Bounded reads reject links, special files, invalid UTF-8 and duplicate JSON keys.
 * @param {string} path @param {number} cap */
function readReceipt(path, cap) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('receipt-file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) throw new Error('receipt-size');
    const bytes = Buffer.alloc(cap + 1);
    // A fixed read cap also bounds a file growing after fstat.
    const data = readFileBounded(fd, bytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const value = JSON.parse(text);
    const stack = /** @type {Set<string>[]} */ ([]);
    for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]]/gu)) {
      if (token[0] === '{' || token[0] === '[') {
        if (stack.length >= 16) throw new Error('receipt-depth');
        stack.push(new Set());
      } else if (token[0] === '}' || token[0] === ']') stack.pop();
      else if (/^\s*:/u.test(text.slice(token.index + token[0].length))) {
        const key = JSON.parse(token[0]);
        const keys = stack.at(-1);
        if (!keys || keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('receipt-key');
        keys.add(key);
      }
    }
    return { value, digest: createHash('sha256').update(data).digest('hex') };
  } finally { closeSync(fd); }
}

/** @param {number} fd @param {Buffer} bytes */
function readFileBounded(fd, bytes) {
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) return bytes.subarray(0, length);
    length += count;
  }
  throw new Error('receipt-size');
}

/** The host cache is a trusted local input, never a file from the data checkout.
 * @param {{directory: string|null, root: string, repository: string, commit: string, protectedBranch: string}} options
 * @param {import('./notice-guard.mjs').GuardedNotice[]} notices
 * @returns {Record<string,string[]>} */
export function readNoticeApprovals(options, notices) {
  const approvedBy = /** @type {Record<string,string[]>} */ ({});
  if (!options.directory) return approvedBy;
  try {
    const key = createHash('sha256').update(options.repository).digest('hex');
    const directory = join(options.directory, key, options.commit);
    for (const path of [options.directory, join(options.directory, key), directory]) {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('receipt-directory');
    }
    const location = relative(realpathSync(options.root), realpathSync(directory));
    if (location === '' || (!location.startsWith('..') && !isAbsolute(location))) throw new Error('receipt-checkout');
    const artifact = readReceipt(join(directory, 'approvals.json'), 256 * 1024);
    const receipt = approvalsSchema.parse(artifact.value);
    const trust = trustSchema.parse(readReceipt(join(directory, 'trust.json'), 16384).value);
    if (trust.repository !== options.repository || trust.commit !== options.commit || receipt.commit !== options.commit ||
        trust.projectId !== receipt.projectId || trust.ref !== options.protectedBranch || trust.artifactDigest !== artifact.digest ||
        receipt.notices.some((n) => n.pipeline.id !== trust.pipelineId)) throw new Error('receipt-binding');
    // readSharedContext has already proved this exact commit reachable from the configured protected ref.
    for (const notice of notices) {
      const match = receipt.notices.find((n) => n.recordId === notice.recordId && n.contentDigest === notice.contentDigest);
      if (!match || !notice.record) continue;
      if (match.approvers.includes(notice.record.author)) notice.quarantineReasons.push('approval-receipt');
      else approvedBy[notice.record.recordId] = match.approvers;
    }
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      // Invalid containers cannot be reliably attributed to just one record.
      for (const notice of notices) notice.quarantineReasons.push('approval-receipt');
    }
  }
  return approvedBy;
}
