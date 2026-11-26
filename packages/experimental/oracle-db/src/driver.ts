/**
 * The part of node-oracledb that the plugin uses. The plugin entry passes the real `oracledb` module,
 * which runs in its pure-JavaScript Thin mode because nothing calls `initOracleClient`; tests pass a fake.
 * @module
 */

/** A node-oracledb database type constant, used to request a fetch conversion. */
export interface OracleFetchType {
  /** The constant's node-oracledb name, such as `DB_TYPE_VARCHAR`. */
  readonly name: string
}

/** One result column as node-oracledb describes it. */
export interface OracleColumn {
  /** Column name as the database reports it; unquoted names are uppercase. */
  readonly name: string
  /** Oracle type name, such as `VARCHAR2`, `DATE`, or `TIMESTAMP WITH TIME ZONE`. */
  readonly dbTypeName: string
}

/** A fetch conversion returned by {@link OracleExecuteOptions.fetchTypeHandler}. */
export interface OracleFetchOverride {
  /** The type node-oracledb converts the column to before returning it. */
  readonly type: OracleFetchType
}

/** Options for one {@link OracleConnection.execute} call. */
export interface OracleExecuteOptions {
  /** Most rows the driver fetches; it stops fetching after this many. */
  readonly maxRows: number
  /**
   * Choose a fetch conversion for each result column.
   * @param column - the column node-oracledb is about to fetch.
   * @returns the conversion, or `undefined` for the driver's default.
   */
  readonly fetchTypeHandler: (column: OracleColumn) => OracleFetchOverride | undefined
}

/** The rows of one query, each row an array in column order. */
export interface OracleResult {
  /** Column descriptions; absent for statements that return no rows. */
  readonly metaData?: readonly OracleColumn[]
  /** Fetched rows; absent for statements that return no rows. */
  readonly rows?: readonly (readonly unknown[])[]
}

/** Named bind values for one statement. */
export type OracleBinds = Readonly<Record<string, string>>

/** One pooled database session. */
export interface OracleConnection {
  /** Limit in milliseconds for each round trip to the database; 0 means none. */
  callTimeout: number
  /**
   * Run one SQL statement.
   * @param sql - the statement text.
   * @param binds - named bind values.
   * @param options - fetch limits and conversions.
   * @returns the statement's rows and column descriptions.
   */
  execute(sql: string, binds?: OracleBinds, options?: OracleExecuteOptions): Promise<OracleResult>
  /**
   * Roll back the session's current transaction.
   * @returns settles when the database confirms the rollback.
   */
  rollback(): Promise<void>
  /**
   * Return the session to its pool, rolling back any open transaction.
   * @returns settles when the pool holds the session again.
   */
  release(): Promise<void>
  /**
   * Interrupt the statement currently running on this session.
   * @returns settles when the database acknowledges the break.
   */
  break(): Promise<void>
}

/** A pool of database sessions for one user. */
export interface OraclePool {
  /**
   * Borrow a session, opening one when none is idle and the pool has room.
   * @returns the borrowed session.
   */
  getConnection(): Promise<OracleConnection>
  /**
   * Close the pool and its sessions.
   * @param drainTime - seconds to wait for borrowed sessions; 0 closes them at once.
   * @returns settles when every session is closed.
   */
  close(drainTime: number): Promise<void>
}

/** Pool settings passed to {@link OracleDriver.createPool}. */
export interface OraclePoolAttributes {
  /** Database user name. */
  readonly user: string
  /** That user's password. */
  readonly password: string
  /** Easy Connect string or connect descriptor. */
  readonly connectString: string
  /** Sessions the pool keeps open while idle. */
  readonly poolMin: number
  /** Most sessions the pool opens at once. */
  readonly poolMax: number
  /** Sessions the pool opens when it needs more. */
  readonly poolIncrement: number
}

/** The node-oracledb module functions and constants the plugin uses. */
export interface OracleDriver {
  /**
   * Create a session pool. With `poolMin: 0` this opens no session until the first borrow.
   * @param attributes - credentials, address, and pool size.
   * @returns the pool.
   */
  createPool(attributes: OraclePoolAttributes): Promise<OraclePool>
  /** Fetch type that returns a value as a string. */
  readonly STRING: OracleFetchType
  /** Fetch type that returns a value as a `Buffer`. */
  readonly BUFFER: OracleFetchType
}
