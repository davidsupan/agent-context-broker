import { parentPort, workerData } from 'node:worker_threads';
import { ackContextNotice, listContextNotices } from '../src/context-notices.mjs';
import { PENDING_NOTICE_NONCE, sealNoticeLane } from '../src/notice-nonce.mjs';

parentPort.postMessage({ ready: true });
Atomics.wait(new Int32Array(workerData.gate), 0, 0);
if (workerData.operation === 'seal') {
  const lane = { header: `Notice id ${PENDING_NOTICE_NONCE};` };
  const notices = [{ recordId: 'NTC-20261008-abcdef', status: 'unread', contentDigest: 'a'.repeat(64),
    text: `<team-notice-data id=${PENDING_NOTICE_NONCE}>payload</team-notice-data id=${PENDING_NOTICE_NONCE}>` }];
  const warnings = [];
  let spawns = 0;
  sealNoticeLane(lane, notices, workerData.home, [], warnings, {
    platform: 'win32',
    host: () => ({ executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', cwd: 'C:\\Windows\\System32', env: {} }),
    spawn() {
      spawns++;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      throw new Error('ACL unavailable');
    },
    link() { throw Object.assign(new Error('link unavailable'), { code: 'EPERM' }); }
  });
  parentPort.postMessage({ result: { lane, notices, warnings, spawns } });
} else {
  const operation = workerData.operation === 'ack' ? ackContextNotice : listContextNotices;
  parentPort.postMessage({ result: operation(workerData.options) });
}
