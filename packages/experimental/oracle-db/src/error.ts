/** Machine-routable failures of the Oracle database tools, and the translation of driver errors into them. @module */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link OracleDbError} code:
 * - `ORACLE_READ_ONLY` — the statement is not a single read-only query, or the database refused a change inside the read-only transaction.
 * - `ORACLE_PASSWORD_MISSING` — no password is stored or exported under the configured credential reference.
 * - `ORACLE_CONNECT_FAILED` — the plugin could not open, or lost, a database session; the message carries the ORA or NJS code.
 * - `ORACLE_TIMEOUT` — a database round trip exceeded the configured call timeout, or no pooled session became free in time.
 * - `ORACLE_QUERY_FAILED` — the database rejected the statement; the message carries the ORA code.
 */
export const ORACLE_DB_ERROR_CODES = [
  'ORACLE_READ_ONLY',
  'ORACLE_PASSWORD_MISSING',
  'ORACLE_CONNECT_FAILED',
  'ORACLE_TIMEOUT',
  'ORACLE_QUERY_FAILED',
] as const

/** One code from {@link ORACLE_DB_ERROR_CODES}. */
export type OracleDbErrorCode = typeof ORACLE_DB_ERROR_CODES[number]

/** Oracle database tool failure carrying a stable {@link OracleDbErrorCode}. */
export class OracleDbError extends HarnessError {
  override readonly code: OracleDbErrorCode

  /**
   * @param message - what failed and the next step for the model or the user.
   * @param code - the failure class consumers route on.
   * @param options - standard `cause` chaining.
   */
  constructor(message: string, code: OracleDbErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'OracleDbError'
    this.code = code
  }
}

/** Where a driver failure happened: opening a session, or running statements on an open one. */
export type OracleFailurePhase = 'connect' | 'statement'

/** The database a failure refers to, named in connection failures. */
export interface OracleTarget {
  /** The configured connect string. */
  readonly connectString: string
  /** The configured database user. */
  readonly user: string
  /** Credential reference that holds the user's password. */
  readonly passwordRef: string
}

const DRIVER_CODE = /^(?:ORA|NJS|DPI)-\d+$/u

/** Call-timeout expiry in Thin mode (NJS-123), its Thick-mode form (DPI-1067), and a pool wait that ran out (NJS-040). */
const TIMEOUT_CODES: ReadonlySet<string> = new Set(['NJS-123', 'DPI-1067', 'NJS-040'])

/** Listener, service, sign-in, and account failures; node-oracledb reports a lost session as NJS-500 and network failures as NJS-5xx. */
const CONNECT_CODES: ReadonlySet<string> = new Set([
  'ORA-01017', 'ORA-28000', 'ORA-28001', 'ORA-12170', 'ORA-12505', 'ORA-12514', 'ORA-12541', 'ORA-12543', 'ORA-12545',
])

/** A sign-in the database refused: wrong credentials, a locked account, or an expired password. */
const SIGN_IN_CODES: ReadonlySet<string> = new Set(['ORA-01017', 'ORA-28000', 'ORA-28001'])

/** Unknown table or column names, which oracle_schema can resolve. */
const NAME_CODES: ReadonlySet<string> = new Set(['ORA-00904', 'ORA-00942'])

/** The database refused a change inside a `READ ONLY` transaction. */
const READ_ONLY_TRANSACTION_CODE = 'ORA-01456'

/**
 * The ORA, NJS, or DPI code of a node-oracledb error.
 * @param error - any thrown value.
 * @returns the code, or `undefined` when the value is not a driver error.
 */
export function driverCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return undefined
  return DRIVER_CODE.test(error.code) ? error.code : undefined
}

/**
 * The driver's message without its documentation links, prefixed with the code when the driver omitted it.
 * @param error - the driver error.
 * @param code - its ORA, NJS, or DPI code.
 * @returns the code and message on one or more lines.
 */
function driverMessage(error: Error, code: string): string {
  const message = error.message.split('\n').filter(line => !line.startsWith('Help: ')).join('\n').trim()
  return message.startsWith(code) ? message : `${code}: ${message}`
}

/**
 * Translate a node-oracledb error into an {@link OracleDbError} with the next step for the model.
 * Values that are not driver errors, including an existing {@link OracleDbError}, come back unchanged.
 * @param error - the thrown value.
 * @param phase - whether a session was being opened or statements were running on an open one.
 * @param target - the database the plugin connects to.
 * @returns the translated error, or `error` itself.
 */
export function driverFailure(error: unknown, phase: OracleFailurePhase, target: OracleTarget): unknown {
  const code = driverCode(error)
  if (code === undefined || !(error instanceof Error)) return error
  const detail = driverMessage(error, code)
  if (TIMEOUT_CODES.has(code)) {
    const next = code === 'NJS-040'
      ? 'Every pooled database session stayed busy; retry after the other queries finish.'
      : 'Narrow the query with WHERE conditions or FETCH FIRST n ROWS ONLY, or ask the user to raise queryTimeoutMs.'
    return new OracleDbError(`The database call timed out: ${detail}\n${next}`, 'ORACLE_TIMEOUT', { cause: error })
  }
  if (phase === 'connect' || CONNECT_CODES.has(code) || code.startsWith('NJS-5')) {
    const next = SIGN_IN_CODES.has(code)
      ? `The database refused the sign-in for user ${target.user}. Ask the user to check the account and the password stored under ${target.passwordRef}.`
      : 'Ask the user to check that the database is running and reachable and that connectString is correct, then retry.'
    return new OracleDbError(`The connection to the Oracle database ${target.connectString} as ${target.user} failed: ${detail}\n${next}`, 'ORACLE_CONNECT_FAILED', { cause: error })
  }
  if (code === READ_ONLY_TRANSACTION_CODE) {
    return new OracleDbError(`The database refused a change inside the read-only transaction: ${detail}\nThe query calls something that writes data; only reading is allowed.`, 'ORACLE_READ_ONLY', { cause: error })
  }
  const next = NAME_CODES.has(code) ? 'Check table and column names with oracle_schema.' : 'Fix the SQL and retry.'
  return new OracleDbError(`The database rejected the statement: ${detail}\n${next}`, 'ORACLE_QUERY_FAILED', { cause: error })
}
