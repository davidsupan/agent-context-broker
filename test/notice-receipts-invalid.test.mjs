import { test } from 'node:test';
import { createNoticeSuite } from './notice-suite.mjs';
import { checkMalformedReceipt } from './notice-receipt-cases.mjs';

const setup = createNoticeSuite();
for (const malformed of ['author regex', 'author size', 'self approval', 'duplicate approver',
  'duplicate record', 'notice cap', 'approver cap', 'date', 'digest']) {
  test(`malformed receipt quarantines without text: ${malformed}`, (t) => checkMalformedReceipt(t, malformed, setup));
}
