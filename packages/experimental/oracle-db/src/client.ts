/**
 * Database session ownership for the Oracle tools. Each query is checked as one read-only statement,
 * then runs on a pooled session inside `SET TRANSACTION READ ONLY`, is rolled back, and returns its
 * session. The pool is created on first use for the password resolved at that moment; a different
 * password resolved later gets a new pool, and the old one closes once its queries finish.
 * @module
 */

import type { OracleBinds, OracleColumn, OracleConnection, OracleDriver, OracleFetchOverride, OraclePool } from './driver.ts'
import { driverFailure, OracleDbError, type OracleTarget } from './error.ts'
import { checkReadOnlySql } from './read-only.ts'

/** Connection settings and host callbacks for {@link OracleClient}. */
export interface OracleClientOptions extends OracleTarget {
  /** Limit for each database round trip in milliseconds, applied as the session's `callTimeout`. */
  readonly callTimeoutMs: number
  /** Most sessions the pool opens at once; further queries wait for a free session. */
  readonly poolMax: number
  /**
   * Read the password for one connection attempt.
   * @returns the password, or `undefined` while none is configured.
   */
  readonly password: () => Promise<string | undefined>
  /**
   * Report a teardown failure that no caller can act on.
   * @param message - what failed and its consequence.
   */
  readonly warn: (message: string) => void
}

/** Bind values and the row limit for one {@link OracleClient.select}. */
export interface OracleSelectOptions {
  /** Named bind values; omit for a statement without bind variables. */
  readonly binds?: OracleBinds
  /** Most rows to fetch. */
  readonly maxRows: number
}

/** The columns and fetched rows of one query. */
export interface OracleRows {
  /** Column descriptions in select-list order. */
  readonly columns: readonly OracleColumn[]
  /** Rows in fetch order, each value in column order. */
  readonly rows: readonly (readonly unknown[])[]
}

interface PoolSlot {
  /** The password the pool signs in with. */
  readonly password: string
  readonly pool: Promise<OraclePool>
  /** Queries that entered this slot and have not yet returned their session. */
  users: number
}

/**
 * Interrupt the call running on `connection`.
 * @param connection - the session whose statement the caller canceled.
 * @returns settles once the database answers the break.
 */
async function interruptCall(connection: OracleConnection): Promise<void> {
  try {
    await connection.break()
  } catch (_breakFailed) {
    // An unanswered break leaves the statement running until its call timeout ends it; the query still waits for it.
  }
}

/** Runs read-only queries for one plugin instance and owns its session pools until {@link close}. */
export class OracleClient {
  private slot: PoolSlot | undefined
  private readonly operations = new Set<Promise<OracleRows>>()
  private readonly closing = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()

  /**
   * @param driver - node-oracledb, or a test double of the members the client uses.
   * @param options - the database to use and the host callbacks.
   */
  constructor(private readonly driver: OracleDriver, private readonly options: OracleClientOptions) {}

  /**
   * Run one read-only query. The SQL is checked before any session is borrowed. NUMBER and CLOB
   * values are fetched as strings and BLOB values as `Buffer`s. When `signal` aborts, a running
   * statement is interrupted and the query rejects with the signal's reason once its session is back.
   * @param sql - one SELECT or WITH query.
   * @param options - bind values and the row limit.
   * @param signal - the caller's cancellation.
   * @returns the query's columns and rows.
   * @throws OracleDbError with the failure's code, or the abort reason after cancellation.
   */
  async select(sql: string, options: OracleSelectOptions, signal: AbortSignal): Promise<OracleRows> {
    const statement = checkReadOnlySql(sql)
    const operation = this.run(statement, options, AbortSignal.any([signal, this.lifetime.signal]))
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }

  /**
   * Stop accepting queries, interrupt and await the running ones, then close every pool.
   * @returns settles when every pool is closed.
   */
  async close(): Promise<void> {
    this.lifetime.abort(new DOMException('The Oracle database tools stopped.', 'AbortError'))
    await Promise.allSettled(this.operations)
    const slot = this.slot
    this.slot = undefined
    if (slot !== undefined) this.retire(slot)
    await Promise.all(this.closing)
  }

  private async run(statement: string, options: OracleSelectOptions, signal: AbortSignal): Promise<OracleRows> {
    signal.throwIfAborted()
    const password = await this.options.password()
    signal.throwIfAborted()
    if (password === undefined) {
      const ref = this.options.passwordRef
      throw new OracleDbError(
        `No password is set for the Oracle database user ${this.options.user}. Ask the user to store it as the credential ${ref}, or to start DeepSeek Harness with the ${ref} environment variable set.`,
        'ORACLE_PASSWORD_MISSING',
      )
    }
    const slot = this.enter(password)
    try {
      const connection = await this.connect(slot)
      return await this.transact(connection, statement, options, signal)
    } finally {
      this.leave(slot)
    }
  }

  private enter(password: string): PoolSlot {
    let slot = this.slot
    if (slot?.password !== password) {
      const previous = slot
      slot = {
        password,
        users: 0,
        pool: this.driver.createPool({
          user: this.options.user, password, connectString: this.options.connectString,
          poolMin: 0, poolMax: this.options.poolMax, poolIncrement: 1,
        }),
      }
      this.slot = slot
      if (previous !== undefined && previous.users === 0) this.retire(previous)
    }
    slot.users += 1
    return slot
  }

  private leave(slot: PoolSlot): void {
    slot.users -= 1
    if (slot !== this.slot && slot.users === 0) this.retire(slot)
  }

  private async connect(slot: PoolSlot): Promise<OracleConnection> {
    let pool: OraclePool
    try {
      pool = await slot.pool
    } catch (error) {
      // The next query creates a new pool instead of reusing the failed one.
      if (this.slot === slot) this.slot = undefined
      throw driverFailure(error, 'connect', this.options)
    }
    try {
      return await pool.getConnection()
    } catch (error) {
      throw driverFailure(error, 'connect', this.options)
    }
  }

  private async transact(
    connection: OracleConnection, statement: string, options: OracleSelectOptions, signal: AbortSignal,
  ): Promise<OracleRows> {
    let interruption: Promise<void> | undefined
    const interrupt = (): void => { interruption = interruptCall(connection) }
    signal.addEventListener('abort', interrupt, { once: true })
    let result: OracleRows | undefined
    try {
      signal.throwIfAborted()
      connection.callTimeout = this.options.callTimeoutMs
      await connection.execute('SET TRANSACTION READ ONLY')
      const fetched = await connection.execute(statement, options.binds ?? {}, {
        maxRows: options.maxRows, fetchTypeHandler: this.fetchType,
      })
      result = { columns: fetched.metaData ?? [], rows: fetched.rows ?? [] }
    } catch (error) {
      // A break makes the statement fail with ORA-01013; the caller's cancellation is the outcome.
      signal.throwIfAborted()
      throw driverFailure(error, 'statement', this.options)
    } finally {
      signal.removeEventListener('abort', interrupt)
      await interruption
      await this.end(connection, result !== undefined)
    }
    return result
  }

  /**
   * Roll back and return the session. Cleanup failures are reported only after a successful
   * statement; after a failed one, the statement's failure is the outcome.
   */
  private async end(connection: OracleConnection, report: boolean): Promise<void> {
    const failures: unknown[] = []
    try {
      await connection.rollback()
    } catch (error) {
      failures.push(error)
    }
    try {
      await connection.release()
    } catch (error) {
      failures.push(error)
    }
    if (report && failures.length > 0) throw driverFailure(failures[0], 'statement', this.options)
  }

  private retire(slot: PoolSlot): void {
    const closing = this.closePool(slot).finally(() => { this.closing.delete(closing) })
    this.closing.add(closing)
  }

  private async closePool(slot: PoolSlot): Promise<void> {
    let pool: OraclePool
    try {
      pool = await slot.pool
    } catch (_creationFailed) {
      // The query that created the pool reported this failure, and a pool that never opened holds no session.
      return
    }
    try {
      await pool.close(0)
    } catch (error) {
      this.options.warn(`oracle-db: closing the session pool for ${this.options.user} on ${this.options.connectString} failed, so its sessions may stay open until the database ends them: ${String(error)}`)
    }
  }

  private readonly fetchType = (column: OracleColumn): OracleFetchOverride | undefined => {
    switch (column.dbTypeName) {
      case 'NUMBER':
      case 'CLOB':
      case 'NCLOB':
        return { type: this.driver.STRING }
      case 'BLOB':
        return { type: this.driver.BUFFER }
      default:
        return undefined
    }
  }
}
