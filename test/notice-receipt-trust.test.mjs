import { test } from 'node:test';
import { createNoticeSuite } from './notice-suite.mjs';
import { checkMalformedReceipt } from './notice-receipt-cases.mjs';

const setup = createNoticeSuite();
for (const malformed of ['repository', 'project', 'commit', 'pipeline', 'unprotected', 'failed pipeline', 'artifact digest', 'trust size']) {
  test(`malformed receipt quarantines without text: ${malformed}`, (t) => checkMalformedReceipt(t, malformed, setup));
}
