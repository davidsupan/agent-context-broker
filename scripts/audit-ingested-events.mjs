#!/usr/bin/env bun
// Audits an ingested event store against the properties a backfill must hold:
// bi-temporal separation (valid time from the source, transaction time from the run)
// and the absence of raw conversation text in any stored payload.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const runtimeRoot = process.argv[2];
if (!runtimeRoot) {
  console.error('usage: bun scripts/audit-ingested-events.mjs <event-runtime-root>');
  process.exit(1);
}

const recordsRoot = join(runtimeRoot, 'events', 'records');
const files = readdirSync(recordsRoot).filter((name) => name.endsWith('.json')).sort();

const HASH = /^[a-f0-9]{64}$/u;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/u;
const SAFE_SHORT = 64;

const byType = new Map();
const suspects = [];
let occurredBeforeRecorded = 0;
let occurredEqualsRecorded = 0;
let earliestOccurred = null;
let latestOccurred = null;
let earliestRecorded = null;

function walk(value, path, out) {
  if (typeof value === 'string') {
    // Anything long that is not a hash, an ISO timestamp or an acb:// reference is
    // a candidate for leaked prose.
    if (value.length > SAFE_SHORT && !HASH.test(value) && !ISO.test(value) &&
        !value.startsWith('acb://') && !value.startsWith('context://')) {
      out.push({ path, sample: value.slice(0, 60), length: value.length });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`, out);
  }
}

for (const name of files) {
  const event = JSON.parse(readFileSync(join(recordsRoot, name), 'utf8'));
  byType.set(event.eventType, (byType.get(event.eventType) ?? 0) + 1);

  const occurred = Date.parse(event.occurredAt);
  const recorded = Date.parse(event.recordedAt);
  if (occurred < recorded) occurredBeforeRecorded += 1;
  if (occurred === recorded) occurredEqualsRecorded += 1;
  if (earliestOccurred === null || occurred < earliestOccurred) earliestOccurred = occurred;
  if (latestOccurred === null || occurred > latestOccurred) latestOccurred = occurred;
  if (earliestRecorded === null || recorded < earliestRecorded) earliestRecorded = recorded;

  const found = [];
  walk(event.payload, 'payload', found);
  if (found.length > 0) suspects.push({ name, found });
}

console.log('events            : ' + files.length);
console.log('event types       : ' + JSON.stringify(Object.fromEntries(byType)));
console.log('');
console.log('valid time  (occurredAt) spans : ' +
  new Date(earliestOccurred).toISOString() + '  ..  ' + new Date(latestOccurred).toISOString());
console.log('transaction (recordedAt) from  : ' + new Date(earliestRecorded).toISOString());
console.log('occurredAt < recordedAt        : ' + occurredBeforeRecorded + ' / ' + files.length);
console.log('occurredAt == recordedAt       : ' + occurredEqualsRecorded + ' / ' + files.length);
console.log('');
if (suspects.length === 0) {
  console.log('payload prose audit            : clean (no long non-hash strings in any payload)');
} else {
  console.log('payload prose audit            : ' + suspects.length + ' event(s) with suspect strings');
  for (const suspect of suspects.slice(0, 5)) {
    console.log('  ' + suspect.name);
    for (const item of suspect.found.slice(0, 3)) {
      console.log('    ' + item.path + ' (' + item.length + ' chars): ' + item.sample);
    }
  }
}
process.exit(suspects.length === 0 ? 0 : 1);
