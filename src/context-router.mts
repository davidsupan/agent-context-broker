import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ContextProfile = {
  id: string; description: string; taskKinds: string[]; keywords: string[];
  claimTypes: string[]; crossProvider: boolean; maxSnapshots: number;
  maxClaims: number; maxValueBytes: number; maxContextBytes: number;
};
export type ContextProfiles = Readonly<Record<string, Readonly<ContextProfile>>>;
export type ContextRouteInput = { profiles?: ContextProfiles; profilesPath?: string; strictIsolation?: boolean; profileId?: string; taskKind?: unknown; projectScope?: boolean };
export type ContextRoute = { shouldQuery: true; profile: Readonly<ContextProfile>; reason: string } | { shouldQuery: false; profile: Readonly<ContextProfile> | null; reason: string };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultProfilesPath = resolve(packageRoot, 'profiles', 'context-profiles.json');
const CLAIM_TYPES = new Set(['fact', 'decision', 'procedure', 'risk', 'result']);
const PROFILE_FIELDS = new Set([
  'id',
  'description',
  'taskKinds',
  'keywords',
  'claimTypes',
  'crossProvider',
  'maxSnapshots',
  'maxClaims',
  'maxValueBytes',
  'maxContextBytes'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown, { allowEmpty = false }: { allowEmpty?: boolean } = {}): value is string[] {
  return Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every((item) => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validateProfile(profile: unknown): asserts profile is ContextProfile {
  if (!isRecord(profile) || Object.keys(profile).some((key) => !PROFILE_FIELDS.has(key))) {
    throw new Error('Context profile shape is invalid.');
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test((profile.id ?? '') as string) ||
      typeof profile.description !== 'string' || profile.description.length === 0 ||
      !stringArray(profile.taskKinds) ||
      !stringArray(profile.keywords, { allowEmpty: true }) ||
      !stringArray(profile.claimTypes, { allowEmpty: true }) ||
      (Array.isArray(profile.claimTypes) && profile.claimTypes.some((type) => !CLAIM_TYPES.has(type))) ||
      typeof profile.crossProvider !== 'boolean' ||
      !boundedInteger(profile.maxSnapshots, 0, 20) ||
      !boundedInteger(profile.maxClaims, 0, 100) ||
      !boundedInteger(profile.maxValueBytes, 0, 65536) ||
      !boundedInteger(profile.maxContextBytes, 256, 65536)) {
    throw new Error(`Context profile is invalid: ${profile.id ?? 'unknown'}.`);
  }
  if (profile.id === 'strict-isolation' &&
      (profile.crossProvider || profile.maxSnapshots !== 0 ||
       profile.maxClaims !== 0 || profile.maxValueBytes !== 0)) {
    throw new Error('Strict-isolation profile must not admit broker claims.');
  }
}

export function loadContextProfiles(path: string = defaultProfilesPath): ContextProfiles {
  const document: unknown = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!isRecord(document) || document.schemaVersion !== 1 || !Array.isArray(document.profiles)) {
    throw new Error('Context profile document is invalid.');
  }
  const ids = new Set<string>();
  const taskKindOwners = new Map<string, string>();
  for (const profile of document.profiles) {
    validateProfile(profile);
    if (ids.has(profile.id)) throw new Error(`Duplicate context profile: ${profile.id}.`);
    ids.add(profile.id);
    for (const taskKind of profile.taskKinds) {
      if (taskKindOwners.has(taskKind)) {
        throw new Error(`Context task kind has multiple owners: ${taskKind}.`);
      }
      taskKindOwners.set(taskKind, profile.id);
    }
  }
  if (!ids.has('strict-isolation') || !ids.has('custom-project')) {
    throw new Error('Required context profiles are missing.');
  }
  return Object.freeze(Object.fromEntries(
    document.profiles.map((profile) => [profile.id, Object.freeze(structuredClone(profile))])
  ));
}

export function routeContextProfile(input: ContextRouteInput = {}): ContextRoute {
  const profiles = input.profiles ?? loadContextProfiles(input.profilesPath);
  if (input.strictIsolation === true) {
    return {
      shouldQuery: false,
      profile: profiles['strict-isolation'],
      reason: 'strict-isolation-requested'
    };
  }

  if (input.profileId) {
    const explicit = profiles[input.profileId];
    if (!explicit) throw new Error(`Unknown context profile: ${input.profileId}.`);
    return {
      shouldQuery: explicit.id !== 'strict-isolation',
      profile: explicit,
      reason: 'explicit-profile'
    } as ContextRoute;
  }

  const taskKind = String(input.taskKind ?? '').trim().toLowerCase();
  if (taskKind) {
    const matched = Object.values(profiles).find((profile) => profile.taskKinds.includes(taskKind));
    if (matched) {
      return {
        shouldQuery: matched.id !== 'strict-isolation',
        profile: matched,
        reason: 'task-kind'
      } as ContextRoute;
    }
  }

  if (input.projectScope === true) {
    return {
      shouldQuery: true,
      profile: profiles['custom-project'],
      reason: 'project-scope-fallback'
    };
  }

  return {
    shouldQuery: false,
    profile: null,
    reason: 'unscoped-unrouted'
  };
}

export { defaultProfilesPath };
