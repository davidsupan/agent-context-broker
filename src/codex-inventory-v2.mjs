import {
  createMetadataInventoryAdapter,
  hash,
  hashedRelation
} from './metadata-inventory.mjs';

export const ADAPTER_VERSION = '0.2.0';

function sessionMetadata(records) {
  return records.find((record) =>
    record?.type === 'session_meta' &&
    typeof record?.payload?.id === 'string'
  );
}

const adapter = createMetadataInventoryAdapter({
  provider: 'codex',
  adapterVersion: ADAPTER_VERSION,
  sourceNamespace: 'codex-rollout',
  terminalStates: new Set(['completed', 'aborted']),

  hasRequiredMetadata(records) {
    return Boolean(sessionMetadata(records));
  },

  metadataFromRecords(records) {
    const record = sessionMetadata(records);
    if (!record) {
      return null;
    }

    const payload = record.payload;
    const relations = [
      hashedRelation('workspace', payload.cwd),
      hashedRelation('repository', payload.git?.repository_url),
      hashedRelation('branch', payload.git?.branch),
      hashedRelation('parent', payload.forked_from_id)
    ].filter(Boolean);

    return {
      sessionIdHash: hash(`codex-session:${payload.id}`),
      parentSessionIdHash: payload.forked_from_id
        ? hash(`codex-session:${payload.forked_from_id}`)
        : null,
      relationKeys: [...new Set(relations)].sort()
    };
  },

  inspectRecord(record) {
    const lifecycle = record?.type === 'event_msg' &&
      typeof record?.payload?.type === 'string'
      ? record.payload.type
      : null;
    return {
      recordType: record?.type,
      timestamp: record?.timestamp,
      lifecycle
    };
  },

  stateForLifecycle(lifecycle) {
    switch (lifecycle) {
      case 'task_complete': return 'completed';
      case 'turn_aborted': return 'aborted';
      case 'task_started': return 'active';
      default: return null;
    }
  }
});

export const {
  planInventory,
  readRelatedDeltas,
  readSourceIdentity,
  runInventory
} = adapter;
