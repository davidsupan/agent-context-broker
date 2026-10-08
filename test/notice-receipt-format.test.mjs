import { test } from 'node:test';
import { createNoticeSuite } from './notice-suite.mjs';
import { checkMalformedReceipt } from './notice-receipt-cases.mjs';

const setup = createNoticeSuite();
for (const malformed of ['json', 'utf8', 'size', 'extra field', 'extra nested field', 'duplicate key']) {
  test(`malformed receipt quarantines without text: ${malformed}`, (t) => checkMalformedReceipt(t, malformed, setup));
}
