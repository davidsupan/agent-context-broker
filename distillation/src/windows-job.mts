// Kept as the import path the module already uses; the implementation is portable now (see containment.mts).
export {
  CLEANUP_TIMEOUT_MS, ownProcessIdentity, probeNamedJob, probeOwner, registryDir, runContained, windowsLauncherAvailable,
  type ContainedOptions, type ContainedResult, type NamedJobState, type OwnerState, type ProcessIdentity,
} from './containment.mts';
