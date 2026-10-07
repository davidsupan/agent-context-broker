// The subset of bun:test's `expect` and `spyOn` the distillation tests use, on node:test and node:assert, so the
// tests moved from Bun to Node with only their import line changed. Semantics follow Bun (Jest-like):
// `toEqual` ignores undefined object properties, `toMatchObject` checks a recursive subset, `toThrow` takes a
// substring, a RegExp, an Error class or an error-like object.

import assert from 'node:assert/strict';
import { isDeepStrictEqual, inspect } from 'node:util';

export { afterEach, beforeEach, describe, test } from 'node:test';

type Any = any;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Map) && !(v instanceof Set) && !(v instanceof RegExp) && !ArrayBuffer.isView(v);

/** Drops undefined object properties recursively, the way Bun's `toEqual` ignores them. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (isPlain(value)) {
    const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(value));
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = withoutUndefined(v);
    return out;
  }
  return value;
}

function looseEqual(a: unknown, b: unknown): boolean {
  const left = withoutUndefined(a), right = withoutUndefined(b);
  if (isPlain(left) && isPlain(right)) {
    // Like Jest, a class instance equals a plain object with the same own enumerable fields.
    return isDeepStrictEqual({ ...left }, { ...right }) || isDeepStrictEqual(left, right);
  }
  return isDeepStrictEqual(left, right);
}

function subset(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === 'string' ? expected.test(actual) : isDeepStrictEqual(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => subset(actual[i], e));
  if (isPlain(expected)) return typeof actual === 'object' && actual !== null && Object.entries(expected).every(([k, v]) => subset((actual as Any)[k], v));
  return looseEqual(actual, expected);
}

function thrownMatches(error: unknown, expected?: unknown): boolean {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  if (typeof expected === 'string') return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === 'function') return error instanceof (expected as new (...args: Any[]) => unknown);
  if (typeof expected === 'object' && expected !== null && 'message' in expected) return message === (expected as { message: string }).message;
  return false;
}

const show = (v: unknown) => inspect(v, { depth: 6, breakLength: 120 });

type Matchers = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
  toThrow(expected?: unknown): void
  toHaveLength(n: number): void
  toContain(item: unknown): void
  toBeUndefined(): void
  toBeNull(): void
  toBeLessThan(n: number): void
  toBeLessThanOrEqual(n: number): void
  toBeGreaterThan(n: number): void
  toBeGreaterThanOrEqual(n: number): void
  toMatch(pattern: RegExp | string): void
  toHaveProperty(path: string, value?: unknown): void
  toBeString(): void
  toStartWith(prefix: string): void
  toBeTruthy(): void
  toBeFalsy(): void
}

function matchers(actual: unknown, negate: boolean): Matchers {
  const check = (pass: boolean, message: () => string) => { if (pass === negate) assert.fail(`${negate ? 'not ' : ''}${message()}`); };
  const hasPath = (path: string) => {
    let cur: Any = actual;
    for (const key of path.split('.')) { if (cur === null || cur === undefined || !(key in Object(cur))) return { found: false, value: undefined }; cur = cur[key]; }
    return { found: true, value: cur };
  };
  return {
    toBe: (e) => check(Object.is(actual, e), () => `expected ${show(actual)} to be ${show(e)}`),
    toEqual: (e) => check(looseEqual(actual, e), () => `expected ${show(actual)} to equal ${show(e)}`),
    toMatchObject: (e) => check(subset(actual, e), () => `expected ${show(actual)} to match ${show(e)}`),
    toThrow: (e) => {
      if (typeof actual !== 'function') assert.fail('toThrow needs a function');
      let threw = false, error: unknown;
      try { (actual as () => unknown)(); } catch (err) { threw = true; error = err; }
      check(threw && thrownMatches(error, e), () => (threw ? `expected the error ${show(error)} to match ${show(e)}` : 'expected the function to throw'));
    },
    toHaveLength: (n) => check((actual as { length?: number })?.length === n, () => `expected length ${(actual as Any)?.length} to be ${n}`),
    toContain: (item) => check(typeof actual === 'string' ? actual.includes(String(item)) : Array.isArray(actual) || actual instanceof Set ? [...(actual as Iterable<unknown>)].some(v => Object.is(v, item) || isDeepStrictEqual(v, item)) : false, () => `expected ${show(actual)} to contain ${show(item)}`),
    toBeUndefined: () => check(actual === undefined, () => `expected ${show(actual)} to be undefined`),
    toBeNull: () => check(actual === null, () => `expected ${show(actual)} to be null`),
    toBeLessThan: (n) => check((actual as number) < n, () => `expected ${show(actual)} < ${n}`),
    toBeLessThanOrEqual: (n) => check((actual as number) <= n, () => `expected ${show(actual)} <= ${n}`),
    toBeGreaterThan: (n) => check((actual as number) > n, () => `expected ${show(actual)} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check((actual as number) >= n, () => `expected ${show(actual)} >= ${n}`),
    toMatch: (p) => check(typeof actual === 'string' && (typeof p === 'string' ? actual.includes(p) : p.test(actual)), () => `expected ${show(actual)} to match ${show(p)}`),
    toHaveProperty: (path, value) => { const r = hasPath(path); check(r.found && (arguments.length < 2 || value === undefined ? true : looseEqual(r.value, value)), () => `expected ${show(actual)} to have property ${path}`); },
    toBeString: () => check(typeof actual === 'string', () => `expected ${show(actual)} to be a string`),
    toStartWith: (prefix) => check(typeof actual === 'string' && actual.startsWith(prefix), () => `expected ${show(actual)} to start with ${show(prefix)}`),
    toBeTruthy: () => check(Boolean(actual), () => `expected ${show(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, () => `expected ${show(actual)} to be falsy`),
  };
}

type AsyncMatchers = { toThrow(expected?: unknown): Promise<void> };

export function expect(actual: unknown): Matchers & { not: Matchers; rejects: AsyncMatchers & { not: AsyncMatchers }; resolves: { toBe(e: unknown): Promise<void>; toEqual(e: unknown): Promise<void>; toMatchObject(e: unknown): Promise<void> } } {
  const settle = async () => {
    try { return { ok: true as const, value: await (typeof actual === 'function' ? (actual as () => unknown)() : actual) }; }
    catch (error) { return { ok: false as const, error }; }
  };
  const rejects = (negate: boolean): AsyncMatchers => ({
    toThrow: async (e) => {
      const r = await settle();
      const pass = !r.ok && thrownMatches(r.error, e);
      if (pass === negate) assert.fail(r.ok ? 'expected the promise to reject' : `expected the rejection ${show(r.error)} to match ${show(e)}`);
    },
  });
  const resolved = (name: 'toBe' | 'toEqual' | 'toMatchObject') => async (e: unknown) => {
    const r = await settle();
    if (!r.ok) assert.fail(`expected the promise to resolve, it rejected with ${show(r.error)}`);
    matchers(r.value, false)[name](e);
  };
  return Object.assign(matchers(actual, false), {
    not: matchers(actual, true),
    rejects: Object.assign(rejects(false), { not: rejects(true) }),
    resolves: { toBe: resolved('toBe'), toEqual: resolved('toEqual'), toMatchObject: resolved('toMatchObject') },
  });
}

/** A replaceable method, like bun:test's spyOn: `mockImplementation`, `mockReturnValue` and `mockRestore`. */
export function spyOn<T extends object, K extends keyof T>(target: T, key: K) {
  const original = target[key] as unknown as (...args: Any[]) => unknown;
  let impl: (...args: Any[]) => unknown = original;
  const calls: unknown[][] = [];
  const spy = function (this: unknown, ...args: Any[]) { calls.push(args); return impl.apply(this, args); };
  (target as Any)[key] = spy;
  const handle = {
    mock: { calls },
    mockImplementation(fn: (...args: Any[]) => unknown) { impl = fn; return handle; },
    mockReturnValue(value: unknown) { impl = () => value; return handle; },
    mockRestore() { (target as Any)[key] = original; },
  };
  return handle;
}
