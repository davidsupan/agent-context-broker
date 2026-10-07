// A thin facade over node:sqlite with the shape of the bun:sqlite calls the module makes, so the store code moves
// from Bun to Node without changing its queries: `query(sql)` (cached), `prepare(sql)`, statement `get` (null for
// no row), `all`, `run` ({ changes, lastInsertRowid }), `values`, `db.run(sql, ...params)`, `exec`, and
// `transaction(fn)` with `.immediate()`, `.deferred()` and `.exclusive()`; a nested transaction becomes a
// savepoint. Named parameters may be given with or without their `$`, `:` or `@` prefix.

import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type Param = SQLInputValue;
export type Params = Param[] | [Record<string, Param>];
export type RunResult = { changes: number; lastInsertRowid: number | bigint };
export type OpenOptions = { readonly?: boolean; create?: boolean; strict?: boolean };

function sqliteCall<T>(call: () => T): T {
  try { return call(); }
  catch (error) {
    if (error && typeof error === 'object' && 'errcode' in error && error.errcode === 5) {
      Object.assign(error, { code: 'SQLITE_BUSY' });
    }
    throw error;
  }
}
function rowValue(value: unknown): unknown { return typeof value === 'bigint' ? Number(value) : value; }
function plainRow<Row>(row: Record<string, unknown>): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, rowValue(value)])) as Row;
}

export class Statement<Row = Record<string, unknown>> {
  readonly #statement: StatementSync;
  constructor(statement: StatementSync) { this.#statement = statement; statement.setReadBigInts(true); }
  get(...params: Params): Row | null { return sqliteCall(() => { const row = this.#statement.get(...(params as Param[])); return row ? plainRow<Row>(row) : null; }); }
  all(...params: Params): Row[] { return sqliteCall(() => this.#statement.all(...(params as Param[])).map(row => plainRow<Row>(row))); }
  *iterate(...params: Params): IterableIterator<Row> {
    for (const row of sqliteCall(() => this.#statement.iterate(...(params as Param[])))) yield plainRow<Row>(row);
  }
  finalize(): void { /* node:sqlite releases statements with the database. */ }
  values(...params: Params): unknown[][] { return this.all(...params).map(row => Object.values(row as object)); }
  run(...params: Params): RunResult {
    const result = sqliteCall(() => this.#statement.run(...(params as Param[])));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
}

type Mode = 'deferred' | 'immediate' | 'exclusive';
export type Transaction<A extends unknown[], R> = ((...args: A) => R) & Record<Mode, (...args: A) => R>;

export class Database {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<string, Statement<unknown>>();
  #depth = 0;
  #savepoint = 0;
  get inTransaction(): boolean { return this.#db.isTransaction; }

  constructor(path: string, options: OpenOptions = {}) {
    const readOnly = options.readonly === true;
    // bun:sqlite opens an existing file only, unless `create` is set; node:sqlite always creates. Keep Bun's rule.
    if (path !== ':memory:' && (readOnly || options.create === false) && !existsSync(path)) throw new Error(`unable to open database file: ${path}`);
    this.#db = new DatabaseSync(path, { readOnly, allowBareNamedParameters: true });
  }

  /** A statement cached per SQL text, as bun:sqlite's `query` caches. */
  query<Row = Record<string, unknown>>(sql: string): Statement<Row> {
    let statement = this.#cache.get(sql);
    if (!statement) { statement = new Statement<Row>(sqliteCall(() => this.#db.prepare(sql))); this.#cache.set(sql, statement); }
    return statement as Statement<Row>;
  }

  /** A fresh, uncached statement. */
  prepare<Row = Record<string, unknown>>(sql: string): Statement<Row> { return new Statement<Row>(sqliteCall(() => this.#db.prepare(sql))); }

  run(sql: string, ...params: Params): RunResult {
    return params.length ? this.prepare(sql).run(...params) : (this.exec(sql), { changes: 0, lastInsertRowid: 0 });
  }

  exec(sql: string): void { sqliteCall(() => this.#db.exec(sql)); }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R> {
    const runIn = (mode: Mode) => (...args: A): R => {
      const nested = this.#depth > 0;
      const name = `sp${++this.#savepoint}`;
      this.exec(nested ? `SAVEPOINT ${name}` : `BEGIN ${mode.toUpperCase()}`);
      this.#depth += 1;
      try {
        const result = fn(...args);
        this.#depth -= 1;
        this.#db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        return result;
      } catch (error) {
        this.#depth -= 1;
        this.#db.exec(nested ? `ROLLBACK TO ${name}; RELEASE ${name}` : 'ROLLBACK');
        throw error;
      }
    };
    return Object.assign(runIn('deferred'), { deferred: runIn('deferred'), immediate: runIn('immediate'), exclusive: runIn('exclusive') });
  }

  close(): void { this.#cache.clear(); this.#db.close(); }
  [Symbol.dispose](): void { this.close(); }
}
