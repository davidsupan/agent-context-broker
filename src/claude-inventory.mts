import {
  createMetadataInventoryAdapter,
  hash,
  hashedRelation
} from './metadata-inventory.mjs';

export const ADAPTER_VERSION = '0.1.0';

export type ClaudeInventoryRecord = {
  sessionId?: unknown;
  cwd?: unknown;
  gitBranch?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  timestamp?: unknown;
};
export type ClaudeInventoryMetadata = {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  parentUuid: string | null;
};
export type ClaudeInventoryOptions = { source: string; recursive?: boolean; maxFiles?: number; maxScanBytes?: number; tailBootstrapBytes?: number; now?: string | number | Date; [key: string]: unknown };

function firstString(records: ClaudeInventoryRecord[], selector: (record: ClaudeInventoryRecord) => unknown): string | null {
  for (const record of records) {
    const value = selector(record);
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

function nativeMetadata(records: ClaudeInventoryRecord[]): ClaudeInventoryMetadata {
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

  hasRequiredMetadata(records: ClaudeInventoryRecord[]) {
    const metadata = nativeMetadata(records);
    return Boolean(metadata.sessionId && metadata.cwd);
  },

  metadataFromRecords(records: ClaudeInventoryRecord[], sourceId: string) {
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

  inspectRecord(record: ClaudeInventoryRecord) {
    return {
      recordType: record?.type,
      timestamp: record?.timestamp,
      lifecycle: null
    };
  },

  stateForLifecycle(lifecycle: string) {
    switch (lifecycle) {
      case 'session_start': return 'active';
      case 'session_end': return 'completed';
      case 'session_abort': return 'aborted';
      default: return null;
    }
  }
});

export type ClaudeInventoryPlan = Awaited<ReturnType<typeof adapter.planInventory>>;
export type ClaudeInventorySourceIdentity = Awaited<ReturnType<typeof adapter.readSourceIdentity>>;
export type ClaudeRelatedDeltas = Awaited<ReturnType<typeof adapter.readRelatedDeltas>>;
export type ClaudeInventoryResult = Awaited<ReturnType<typeof adapter.runInventory>>;
type ClaudeInventoryExports = {
  planInventory: (options: ClaudeInventoryOptions) => Promise<ClaudeInventoryPlan>;
  readRelatedDeltas: (options: ClaudeInventoryOptions) => Promise<ClaudeRelatedDeltas>;
  readSourceIdentity: (source: string) => Promise<ClaudeInventorySourceIdentity>;
  runInventory: (options: ClaudeInventoryOptions) => Promise<ClaudeInventoryResult>;
};

export const {
  planInventory,
  readRelatedDeltas,
  readSourceIdentity,
  runInventory
}: ClaudeInventoryExports = adapter;
