/** The client's pool ownership, read-only transactions, error translation, cancellation, and teardown. */

import { afterEach, describe, expect, it } from 'vitest'
import { OracleClient, type OracleClientOptions } from '../src/client.ts'
import { OracleDbError } from '../src/error.ts'
import { FakeOracle, oracleError, table } from './fake-oracle.ts'

const clients: OracleClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
})

function setup(options: Partial<OracleClientOptions> = {}) {
  const oracle = new FakeOracle()
  const warnings: string[] = []
  const state = { password: 'secret' as string | undefined, passwordReads: 0 }
  const client = new OracleClient(oracle, {
    connectString: 'dbhost:1521/ORCLPDB1',
    user: 'reporter',
    passwordRef: 'ORACLE_PASSWORD',
    callTimeoutMs: 5_000,
    poolMax: 2,
    password: () => {
      state.passwordReads += 1
      return Promise.resolve(state.password)
    },
    warn: (message) => { warnings.push(message) },
    ...options,
  })
  clients.push(client)
  return { oracle, client, warnings, state }
}

const signal = () => new AbortController().signal

async function failure(promise: Promise<unknown>): Promise<OracleDbError> {
  const error = await promise.then(() => undefined, (reason: unknown) => reason)
  if (!(error instanceof OracleDbError)) throw new Error(`expected an OracleDbError, got ${String(error)}`)
  return error
}

describe('OracleClient', () => {
  it('creates one pool on first use and runs each query in a rolled-back read-only transaction', async () => {
    const { oracle, client, state } = setup()
    oracle.respond = ({ sql }) => table(['N'], [[sql === 'SELECT 1 n FROM dual' ? '1' : '2']])
    expect(oracle.pools).toHaveLength(0)

    const first = await client.select('SELECT 1 n FROM dual;', { maxRows: 11 }, signal())
    const second = await client.select('SELECT 2 n FROM dual', { binds: { name: 'x' }, maxRows: 3 }, signal())

    expect(first).toEqual({ columns: [{ name: 'N', dbTypeName: 'VARCHAR2' }], rows: [['1']] })
    expect(second.rows).toEqual([['2']])
    expect(state.passwordReads).toBe(2)
    expect(oracle.pools).toHaveLength(1)
    expect(oracle.pools[0]?.attributes).toEqual({
      user: 'reporter', password: 'secret', connectString: 'dbhost:1521/ORCLPDB1', poolMin: 0, poolMax: 2, poolIncrement: 1,
    })
    const [one, two] = oracle.connections
    expect(one?.log).toEqual(['SET TRANSACTION READ ONLY', 'SELECT 1 n FROM dual', 'ROLLBACK', 'RELEASE'])
    expect(two?.log).toEqual(['SET TRANSACTION READ ONLY', 'SELECT 2 n FROM dual', 'ROLLBACK', 'RELEASE'])
    expect(one?.callTimeout).toBe(5_000)
  })

  it('passes binds, the row limit, and fetch conversions for NUMBER, LOB, and other columns', async () => {
    const { oracle, client } = setup()
    const seen: unknown[] = []
    oracle.respond = ({ binds, options }) => {
      seen.push(binds, options?.maxRows)
      for (const dbTypeName of ['NUMBER', 'CLOB', 'NCLOB', 'BLOB', 'VARCHAR2', 'DATE']) seen.push(options?.fetchTypeHandler({ name: 'C', dbTypeName })?.type.name)
      return {}
    }
    expect(await client.select('SELECT c FROM t', { maxRows: 5 }, signal())).toEqual({ columns: [], rows: [] })
    await client.select('SELECT c FROM t WHERE x = :x', { binds: { x: 'y' }, maxRows: 2 }, signal())
    expect(seen).toEqual([
      {}, 5, 'DB_TYPE_VARCHAR', 'DB_TYPE_VARCHAR', 'DB_TYPE_VARCHAR', 'DB_TYPE_RAW', undefined, undefined,
      { x: 'y' }, 2, 'DB_TYPE_VARCHAR', 'DB_TYPE_VARCHAR', 'DB_TYPE_VARCHAR', 'DB_TYPE_RAW', undefined, undefined,
    ])
  })

  it('refuses a statement that is not read-only before reading the password or opening a session', async () => {
    const { oracle, client, state } = setup()
    const error = await failure(client.select('DELETE FROM employees', { maxRows: 1 }, signal()))
    expect(error.code).toBe('ORACLE_READ_ONLY')
    expect(state.passwordReads).toBe(0)
    expect(oracle.pools).toHaveLength(0)
  })

  it('reports a missing password with its credential reference and connects once it is set', async () => {
    const { oracle, client, state } = setup()
    state.password = undefined
    const error = await failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    expect(error.code).toBe('ORACLE_PASSWORD_MISSING')
    expect(error.message).toBe('No password is set for the Oracle database user reporter. Ask the user to store it as the credential ORACLE_PASSWORD, or to start DeepSeek Harness with the ORACLE_PASSWORD environment variable set.')
    expect(oracle.pools).toHaveLength(0)
    state.password = 'secret'
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    expect(oracle.pools).toHaveLength(1)
  })

  it('does not reuse a pool whose creation failed', async () => {
    const { oracle, client } = setup()
    oracle.createPoolFailure = oracleError('NJS-515', 'error in Easy Connect connection string: missing host')
    const error = await failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    expect(error.code).toBe('ORACLE_CONNECT_FAILED')
    expect(error.message).toBe('The connection to the Oracle database dbhost:1521/ORCLPDB1 as reporter failed: NJS-515: error in Easy Connect connection string: missing host\nAsk the user to check that the database is running and reachable and that connectString is correct, then retry.')
    expect(error.cause).toBe(oracle.createPoolFailure)
    oracle.createPoolFailure = undefined
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    expect(oracle.pools).toHaveLength(1)
  })

  it.each([
    ['ORA-01017', 'invalid credential or not authorized; logon denied', 'The database refused the sign-in for user reporter. Ask the user to check the account and the password stored under ORACLE_PASSWORD.'],
    ['ORA-28000', 'The account is locked.', 'The database refused the sign-in for user reporter.'],
    ['NJS-503', 'connection to host dbhost port 1521 could not be established. (CONNECTION_ID=x)\nconnect ECONNREFUSED', 'Ask the user to check that the database is running'],
    ['ORA-12514', 'Cannot connect to database. Service ORCLPDB1 is not registered with the listener', 'Ask the user to check that the database is running'],
  ])('reports %s while opening a session as ORACLE_CONNECT_FAILED', async (code, text, next) => {
    const { oracle, client } = setup()
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    const pool = oracle.pools[0]
    if (pool !== undefined) pool.getConnectionFailure = oracleError(code, text)
    const error = await failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    expect(error.code).toBe('ORACLE_CONNECT_FAILED')
    expect(error.message).toContain(`${code}: ${text.split('\n')[0] ?? ''}`)
    expect(error.message).not.toContain('Help:')
    expect(error.message).toContain(next)
    expect(oracle.pools).toHaveLength(1)
  })

  it('reports a pool wait that ran out as ORACLE_TIMEOUT', async () => {
    const { oracle, client } = setup()
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    const pool = oracle.pools[0]
    if (pool !== undefined) pool.getConnectionFailure = oracleError('NJS-040', 'connection request timeout. Request exceeded "queueTimeout" of 60000')
    const error = await failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    expect(error.code).toBe('ORACLE_TIMEOUT')
    expect(error.message).toContain('Every pooled database session stayed busy; retry after the other queries finish.')
  })

  it.each([
    ['ORA-00942', 'table or view does not exist', 'ORACLE_QUERY_FAILED', 'The database rejected the statement: ORA-00942: table or view does not exist\nCheck table and column names with oracle_schema.'],
    ['ORA-00904', '"SALRY": invalid identifier', 'ORACLE_QUERY_FAILED', 'The database rejected the statement: ORA-00904: "SALRY": invalid identifier\nCheck table and column names with oracle_schema.'],
    ['ORA-01722', 'invalid number', 'ORACLE_QUERY_FAILED', 'The database rejected the statement: ORA-01722: invalid number\nFix the SQL and retry.'],
    ['NJS-123', 'call timeout of 5000 ms exceeded', 'ORACLE_TIMEOUT', 'The database call timed out: NJS-123: call timeout of 5000 ms exceeded\nNarrow the query with WHERE conditions or FETCH FIRST n ROWS ONLY, or ask the user to raise queryTimeoutMs.'],
    ['DPI-1067', 'call timeout of 5000 ms exceeded with ORA-3156', 'ORACLE_TIMEOUT', 'The database call timed out: DPI-1067: call timeout of 5000 ms exceeded with ORA-3156\nNarrow the query'],
    ['NJS-500', 'connection to Oracle Database was closed or broken', 'ORACLE_CONNECT_FAILED', 'failed: NJS-500: connection to Oracle Database was closed or broken\nAsk the user'],
    ['ORA-12541', 'Cannot connect. No listener at host dbhost port 1521.', 'ORACLE_CONNECT_FAILED', 'failed: ORA-12541'],
    ['ORA-01456', 'may not perform insert/delete/update operation inside a READ ONLY transaction', 'ORACLE_READ_ONLY', 'The database refused a change inside the read-only transaction: ORA-01456: may not perform insert/delete/update operation inside a READ ONLY transaction\nThe query calls something that writes data; only reading is allowed.'],
  ])('translates %s from a statement and still rolls back and releases the session', async (code, text, expected, message) => {
    const { oracle, client } = setup()
    oracle.respond = () => { throw oracleError(code, text) }
    const error = await failure(client.select('SELECT x FROM t', { maxRows: 1 }, signal()))
    expect(error.code).toBe(expected)
    expect(error.message).toContain(message)
    expect(oracle.connections[0]?.log).toEqual(['SET TRANSACTION READ ONLY', 'SELECT x FROM t', 'ROLLBACK', 'RELEASE'])
  })

  it('prefixes a driver message that lacks its code and passes other errors through unchanged', async () => {
    const { oracle, client } = setup()
    oracle.respond = () => { throw Object.assign(new Error('value too large'), { code: 'ORA-12899' }) }
    expect((await failure(client.select('SELECT x FROM t', { maxRows: 1 }, signal()))).message).toContain('ORA-12899: value too large')
    const defect = new TypeError('defect')
    oracle.respond = () => { throw defect }
    await expect(client.select('SELECT x FROM t', { maxRows: 1 }, signal())).rejects.toBe(defect)
    const foreign = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
    oracle.respond = () => { throw foreign }
    await expect(client.select('SELECT x FROM t', { maxRows: 1 }, signal())).rejects.toBe(foreign)
    oracle.respond = () => { throw Object.assign(new Error('odd'), { code: 42 }) }
    await expect(client.select('SELECT x FROM t', { maxRows: 1 }, signal())).rejects.toThrow('odd')
    expect(oracle.connections.every(connection => connection.released)).toBe(true)
  })

  it('translates a failure to start the read-only transaction', async () => {
    const { oracle, client } = setup()
    oracle.transactionFailure = oracleError('ORA-01453', 'SET TRANSACTION must be first statement of transaction')
    const error = await failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    expect(error.code).toBe('ORACLE_QUERY_FAILED')
    expect(oracle.connections[0]?.log).toEqual(['SET TRANSACTION READ ONLY', 'ROLLBACK', 'RELEASE'])
  })

  it('reports a cleanup failure after a successful query, and the query failure when both fail', async () => {
    const { oracle, client } = setup()
    oracle.respond = ({ connection }) => {
      connection.rollbackFailure = oracleError('NJS-500', 'connection to Oracle Database was closed or broken')
      return table(['N'], [['1']])
    }
    expect((await failure(client.select('SELECT 1 n FROM dual', { maxRows: 1 }, signal()))).code).toBe('ORACLE_CONNECT_FAILED')
    expect(oracle.connections[0]?.released).toBe(true)

    oracle.respond = ({ connection }) => {
      connection.releaseFailure = oracleError('NJS-003', 'invalid or closed connection')
      return table(['N'], [['1']])
    }
    expect((await failure(client.select('SELECT 1 n FROM dual', { maxRows: 1 }, signal()))).message).toContain('NJS-003')

    oracle.respond = ({ connection }) => {
      connection.rollbackFailure = oracleError('NJS-500', 'connection to Oracle Database was closed or broken')
      connection.releaseFailure = oracleError('NJS-003', 'invalid or closed connection')
      throw oracleError('ORA-00942', 'table or view does not exist')
    }
    expect((await failure(client.select('SELECT 1 n FROM t', { maxRows: 1 }, signal()))).code).toBe('ORACLE_QUERY_FAILED')
  })

  it('opens a new pool when the password changes and closes the old one once its queries finish', async () => {
    const { oracle, client, state } = setup()
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    state.password = 'rotated'
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    await Promise.resolve()
    expect(oracle.pools.map(pool => [pool.attributes.password, pool.closedWith])).toEqual([['secret', 0], ['rotated', undefined]])

    let finish!: () => void
    oracle.respond = ({ sql }) => (sql === 'SELECT slow FROM dual' ? new Promise((resolve) => { finish = () => { resolve(table(['SLOW'], [['done']])) } }) : table([], []))
    const slow = client.select('SELECT slow FROM dual', { maxRows: 1 }, signal())
    await new Promise(resolve => setTimeout(resolve, 0))
    state.password = 'again'
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    expect(oracle.pools[1]?.closedWith).toBeUndefined()
    finish()
    expect((await slow).rows).toEqual([['done']])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(oracle.pools.map(pool => pool.closedWith)).toEqual([0, 0, undefined])
  })

  it('leaves a newer pool in place when an older pool\'s creation fails, and closes nothing for either', async () => {
    const oracle = new FakeOracle()
    oracle.createPoolFailure = oracleError('NJS-125', '"connectString" cannot be empty or undefined')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const passwords = ['first', 'second']
    const client = new OracleClient(oracle, {
      connectString: '', user: 'reporter', passwordRef: 'ORACLE_PASSWORD', callTimeoutMs: 1_000, poolMax: 2, warn: () => {},
      password: () => gate.then(() => passwords.shift()),
    })
    clients.push(client)
    const first = failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    const second = failure(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    release()
    expect((await first).code).toBe('ORACLE_CONNECT_FAILED')
    expect((await second).code).toBe('ORACLE_CONNECT_FAILED')
    await client.close()
    expect(oracle.pools).toHaveLength(0)
  })

  it('interrupts a running statement when the caller aborts and rejects with the abort reason', async () => {
    const { oracle, client } = setup()
    oracle.respond = ({ connection }) => connection.untilBreak()
    const controller = new AbortController()
    const running = client.select('SELECT pg_sleep FROM dual', { maxRows: 1 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    const reason = new DOMException('stopped by the user', 'AbortError')
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
    expect(oracle.connections[0]?.log).toEqual(['SET TRANSACTION READ ONLY', 'SELECT pg_sleep FROM dual', 'BREAK', 'ROLLBACK', 'RELEASE'])
  })

  it('still waits for the statement when the break fails', async () => {
    const { oracle, client } = setup()
    let finish!: () => void
    oracle.respond = ({ connection }) => {
      connection.breakFailure = oracleError('NJS-500', 'connection to Oracle Database was closed or broken')
      return new Promise((_resolve, reject) => { finish = () => { reject(oracleError('NJS-123', 'call timeout of 5000 ms exceeded')) } })
    }
    const controller = new AbortController()
    const running = client.select('SELECT x FROM t', { maxRows: 1 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    let settled = false
    void running.catch(() => undefined).then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    finish()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(oracle.connections[0]?.released).toBe(true)
  })

  it('does not open a session for a caller that aborted before or while the password was read', async () => {
    const { oracle, client } = setup()
    const controller = new AbortController()
    controller.abort()
    await expect(client.select('SELECT 1 FROM dual', { maxRows: 1 }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const late = new AbortController()
    const lateClient = new OracleClient(oracle, {
      connectString: 'db', user: 'u', passwordRef: 'P', callTimeoutMs: 1_000, poolMax: 2, warn: () => {},
      password: () => {
        late.abort()
        return Promise.resolve('secret')
      },
    })
    clients.push(lateClient)
    await expect(lateClient.select('SELECT 1 FROM dual', { maxRows: 1 }, late.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(oracle.pools).toHaveLength(0)
  })

  it('returns a session borrowed after the caller aborted without running the statement', async () => {
    const { oracle, client } = setup()
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    const pool = oracle.pools[0]
    let open!: () => void
    if (pool !== undefined) pool.gate = new Promise((resolve) => { open = resolve })
    const controller = new AbortController()
    const waiting = client.select('SELECT 2 FROM dual', { maxRows: 1 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    open()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(oracle.connections[1]?.log).toEqual(['ROLLBACK', 'RELEASE'])
  })

  it('on close interrupts and awaits running queries, closes the pool, and refuses later queries', async () => {
    const { oracle, client } = setup()
    oracle.respond = ({ connection }) => connection.untilBreak()
    const running = client.select('SELECT x FROM t', { maxRows: 1 }, signal())
    const stopped = expect(running).rejects.toMatchObject({ name: 'AbortError', message: 'The Oracle database tools stopped.' })
    await new Promise(resolve => setTimeout(resolve, 0))
    await client.close()
    await stopped
    expect(oracle.connections[0]?.log).toEqual(['SET TRANSACTION READ ONLY', 'SELECT x FROM t', 'BREAK', 'ROLLBACK', 'RELEASE'])
    expect(oracle.pools[0]?.closedWith).toBe(0)
    await expect(client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())).rejects.toMatchObject({ name: 'AbortError' })
    expect(oracle.pools).toHaveLength(1)
  })

  it('closes without a pool, after a failed pool creation, and warns when a pool fails to close', async () => {
    const idle = setup()
    await idle.client.close()
    expect(idle.oracle.pools).toHaveLength(0)

    const failed = setup()
    failed.oracle.createPoolFailure = oracleError('NJS-125', '"connectString" cannot be empty or undefined')
    await failure(failed.client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal()))
    await failed.client.close()

    const { oracle, client, warnings } = setup()
    await client.select('SELECT 1 FROM dual', { maxRows: 1 }, signal())
    const pool = oracle.pools[0]
    if (pool !== undefined) pool.closeFailure = oracleError('NJS-104', 'connection pool cannot be closed because connections are busy')
    await client.close()
    expect(warnings).toEqual([
      'oracle-db: closing the session pool for reporter on dbhost:1521/ORCLPDB1 failed, so its sessions may stay open until the database ends them: Error: NJS-104: connection pool cannot be closed because connections are busy',
    ])
  })
})
