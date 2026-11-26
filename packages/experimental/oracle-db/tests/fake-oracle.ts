/** A scripted stand-in for node-oracledb that records every pool, session, and statement. */

import type {
  OracleBinds, OracleConnection, OracleDriver, OracleExecuteOptions, OraclePool, OraclePoolAttributes, OracleResult,
} from '../src/driver.ts'

/** One statement a fake session received. */
export interface FakeStatement {
  readonly sql: string
  readonly binds: OracleBinds | undefined
  readonly options: OracleExecuteOptions | undefined
  readonly connection: FakeConnection
}

/** Produces the outcome of each statement other than `SET TRANSACTION READ ONLY`. */
export type FakeResponder = (statement: FakeStatement) => OracleResult | Promise<OracleResult>

/**
 * An error shaped like the ones node-oracledb throws: `code`, `errorNum` for ORA errors, and the help line Thin mode appends.
 * @param code - such as `ORA-00942` or `NJS-503`.
 * @param text - the message after the code.
 * @returns the error.
 */
export function oracleError(code: string, text: string): Error {
  const digits = code.slice(4)
  const ora = code.startsWith('ORA-')
  const message = ora ? `${code}: ${text}\nHelp: https://docs.oracle.com/error-help/db/ora-${digits}/` : `${code}: ${text}`
  return Object.assign(new Error(message), { code, ...ora ? { errorNum: Number(digits), offset: 0 } : {} })
}

/**
 * A result with column descriptions and rows.
 * @param columns - column names, optionally with an Oracle type after a colon, such as `HIRED:DATE`.
 * @param rows - row values in column order.
 * @returns the result.
 */
export function table(columns: readonly string[], rows: readonly (readonly unknown[])[]): OracleResult {
  return {
    metaData: columns.map((column) => {
      const [name = column, dbTypeName = 'VARCHAR2'] = column.split(':')
      return { name, dbTypeName }
    }),
    rows,
  }
}

/** A fake session that logs `SET TRANSACTION`, statements, `ROLLBACK`, `RELEASE`, and `BREAK`. */
export class FakeConnection implements OracleConnection {
  callTimeout = 0
  readonly log: string[] = []
  released = false
  rollbackFailure: Error | undefined
  releaseFailure: Error | undefined
  breakFailure: Error | undefined
  private readonly breakWaiters: Array<() => void> = []

  constructor(readonly pool: FakePool) {}

  async execute(sql: string, binds?: OracleBinds, options?: OracleExecuteOptions): Promise<OracleResult> {
    this.log.push(sql)
    if (sql === 'SET TRANSACTION READ ONLY') {
      if (this.pool.oracle.transactionFailure !== undefined) throw this.pool.oracle.transactionFailure
      return {}
    }
    return await this.pool.oracle.respond({ sql, binds, options, connection: this })
  }

  async rollback(): Promise<void> {
    this.log.push('ROLLBACK')
    if (this.rollbackFailure !== undefined) throw this.rollbackFailure
  }

  async release(): Promise<void> {
    this.log.push('RELEASE')
    this.released = true
    if (this.releaseFailure !== undefined) throw this.releaseFailure
  }

  async break(): Promise<void> {
    this.log.push('BREAK')
    for (const wake of this.breakWaiters.splice(0)) wake()
    if (this.breakFailure !== undefined) throw this.breakFailure
  }

  /**
   * A statement outcome that waits for a break, then fails the way Oracle reports a canceled call.
   * @returns rejects with ORA-01013 once `break()` runs.
   */
  async untilBreak(): Promise<OracleResult> {
    await new Promise<void>((resolve) => { this.breakWaiters.push(resolve) })
    throw oracleError('ORA-01013', 'user requested cancel of current operation')
  }
}

/** A fake pool that hands out new sessions and records its closing. */
export class FakePool implements OraclePool {
  readonly connections: FakeConnection[] = []
  closedWith: number | undefined
  getConnectionFailure: Error | undefined
  closeFailure: Error | undefined
  /** When set, `getConnection` waits for this promise before answering. */
  gate: Promise<void> | undefined

  constructor(readonly oracle: FakeOracle, readonly attributes: OraclePoolAttributes) {}

  async getConnection(): Promise<OracleConnection> {
    await this.gate
    if (this.getConnectionFailure !== undefined) throw this.getConnectionFailure
    const connection = new FakeConnection(this)
    this.connections.push(connection)
    return connection
  }

  async close(drainTime: number): Promise<void> {
    if (this.closeFailure !== undefined) throw this.closeFailure
    this.closedWith = drainTime
  }
}

/** The fake driver: a responder for statements and a record of the pools it created. */
export class FakeOracle implements OracleDriver {
  readonly STRING = { name: 'DB_TYPE_VARCHAR' }
  readonly BUFFER = { name: 'DB_TYPE_RAW' }
  readonly pools: FakePool[] = []
  createPoolFailure: Error | undefined
  transactionFailure: Error | undefined
  respond: FakeResponder = () => table([], [])

  async createPool(attributes: OraclePoolAttributes): Promise<OraclePool> {
    if (this.createPoolFailure !== undefined) throw this.createPoolFailure
    const pool = new FakePool(this, attributes)
    this.pools.push(pool)
    return pool
  }

  /** Every session the fake handed out, across pools. */
  get connections(): FakeConnection[] {
    return this.pools.flatMap(pool => pool.connections)
  }

  /** Every statement the fake received, in order, except the read-only transaction setup. */
  get statements(): string[] {
    return this.connections.flatMap(connection => connection.log).filter(entry => !['SET TRANSACTION READ ONLY', 'ROLLBACK', 'RELEASE', 'BREAK'].includes(entry))
  }

  /** Forget the responder, failures, and pools between tests. */
  reset(): void {
    this.pools.length = 0
    this.createPoolFailure = undefined
    this.transactionFailure = undefined
    this.respond = () => table([], [])
  }
}
