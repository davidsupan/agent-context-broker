import {
  createMetadataInventoryAdapter,
  hash,
  hashedRelation
} from './metadata-inventory.mjs';

export const ADAPTER_VERSION = '0.1.0';

function firstString(records, selector) {
  for (const record of records) {
    const value = selector(record);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function nativeMetadata(records) {
  return {
    sessionId: firstString(records, (record) => record?.sessionId),
    cwd: firstString(records, (record) => record?.cwd),
    gitBranch: firstString(records, (record) => record?.gitBranch),
    parentUuid: firstString(records, (record) => record?.parentUuid)
  };
}

const adapter = createMetadataInventoryAdapter({
  provider: 'claude-code',
  adapterVersion: ADAPTER_VERSION,
  sourceNamespace: 'claude-code-history',
  terminalStates: new Set(['completed', 'aborted']),

  hasRequiredMetadata(records) {
    const metadata = nativeMetadata(records);
    return Boolean(metadata.sessionId && metadata.cwd);
  },

  metadataFromRecords(records, sourceId) {
    const metadata = nativeMetadata(records);
    if (!metadata.sessionId) {
      return null;
    }

    const relations = [
      hashedRelation('workspace', metadata.cwd),
      hashedRelation('repository', metadata.cwd),
      hashedRelation('branch', metadata.gitBranch),
      hashedRelation('parent', metadata.parentUuid)
    ].filter(Boolean);

    return {
      sessionIdHash: hash(`claude-code-session:${metadata.sessionId}`),
      parentSessionIdHash: metadata.parentUuid
        ? hash(`claude-code-record:${metadata.parentUuid}`)
        : null,
      relationKeys: relations.length > 0
        ? [...new Set(relations)].sort()
        : [hashedRelation('source', sourceId)]
    };
  },

  inspectRecord(record) {
    return {
      recordType: record?.type,
      timestamp: record?.timestamp,
      lifecycle: null
    };
  },

  stateForLifecycle(lifecycle) {
    switch (lifecycle) {
      case 'session_start': return 'active';
      case 'session_end': return 'completed';
      case 'session_abort': return 'aborted';
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
