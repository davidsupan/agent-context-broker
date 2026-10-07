import {
  createMetadataInventoryAdapter,
  hash,
  hashedRelation
} from './metadata-inventory.mjs';

export const ADAPTER_VERSION = '0.2.0';

export type CodexInventoryRecord = {
  type?: unknown;
  timestamp?: unknown;
  payload?: { id?: unknown; cwd?: unknown; git?: { repository_url?: unknown; branch?: unknown }; forked_from_id?: unknown; type?: unknown };
};
export type CodexSessionMetadata = CodexInventoryRecord & { payload: NonNullable<CodexInventoryRecord['payload']> & { id: string } };
export type CodexInventoryOptions = { source: string; recursive?: boolean; maxFiles?: number; maxScanBytes?: number; tailBootstrapBytes?: number; now?: string | number | Date; [key: string]: unknown };

function sessionMetadata(records: CodexInventoryRecord[]): CodexSessionMetadata | undefined {
  return records.find((record): record is CodexSessionMetadata =>
    record?.type === 'session_meta' &&
    typeof record?.payload?.id === 'string'
  );
}

const adapter = createMetadataInventoryAdapter({
  provider: 'codex',
  adapterVersion: ADAPTER_VERSION,
  sourceNamespace: 'codex-rollout',
  terminalStates: new Set(['completed', 'aborted']),

  hasRequiredMetadata(records: CodexInventoryRecord[]) {
    return Boolean(sessionMetadata(records));
  },

  metadataFromRecords(records: CodexInventoryRecord[]) {
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

  inspectRecord(record: CodexInventoryRecord) {
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

  stateForLifecycle(lifecycle: string) {
    switch (lifecycle) {
      case 'task_complete': return 'completed';
      case 'turn_aborted': return 'aborted';
      case 'task_started': return 'active';
      default: return null;
    }
  }
});

export type CodexInventoryPlan = Awaited<ReturnType<typeof adapter.planInventory>>;
export type CodexInventorySourceIdentity = Awaited<ReturnType<typeof adapter.readSourceIdentity>>;
export type CodexRelatedDeltas = Awaited<ReturnType<typeof adapter.readRelatedDeltas>>;
export type CodexInventoryResult = Awaited<ReturnType<typeof adapter.runInventory>>;
type CodexInventoryExports = {
  planInventory: (options: CodexInventoryOptions) => Promise<CodexInventoryPlan>;
  readRelatedDeltas: (options: CodexInventoryOptions) => Promise<CodexRelatedDeltas>;
  readSourceIdentity: (source: string) => Promise<CodexInventorySourceIdentity>;
  runInventory: (options: CodexInventoryOptions) => Promise<CodexInventoryResult>;
};

export const {
  planInventory,
  readRelatedDeltas,
  readSourceIdentity,
  runInventory
}: CodexInventoryExports = adapter;
