/**
 * Read-only Oracle database tools for the model: browse the data dictionary and run SELECT queries.
 * node-oracledb runs in its pure-JavaScript Thin mode, so the host needs no Oracle client libraries.
 * The password stays out of configuration and is read from the credential store, or the launch
 * environment, for each connection attempt.
 * @module @deepseek-ai/dsh-oracle-db
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef, resolveCredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import oracledb from 'oracledb'
import { OracleClient } from './client.ts'
import { registerOracleTools } from './tools.ts'

export { OracleDbError, type OracleDbErrorCode } from './error.ts'

/** Cordis identity for the Oracle database tools. */
export const name = 'oracle-db'

/** Services required before activation; the credentials service is optional. */
export const inject = ['tools', 'systemPrompt']

/** The database to connect to and the limits for each tool call. */
export interface Config {
  /** Easy Connect string such as `dbhost:1521/ORCLPDB1`, or a full connect descriptor. */
  connectString: string
  /** Database user the tools sign in as; a read-only account is the real write boundary. */
  user: string
  /** Credential reference holding the user's password: a stored credential, else this launch environment variable. */
  passwordEnv?: string
  /** Most rows one query or listing returns, and the default for `max_rows`. */
  maxRows?: number
  /** Limit for each database round trip in milliseconds, applied as the session's `callTimeout`. */
  queryTimeoutMs?: number
  /** Most database sessions open at once; further queries wait for a free session. */
  poolMax?: number
  /** Most characters one result cell takes. */
  maxCellChars?: number
  /** Most characters one complete tool result takes. */
  maxOutputChars?: number
}

type ResolvedConfig = Required<Config>

/** Loader defaults and validation. */
export const Config: Schema<Config, ResolvedConfig> = Schema.object({
  connectString: Schema.string().min(1).required(),
  user: Schema.string().min(1).required(),
  passwordEnv: Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).default('ORACLE_PASSWORD'),
  maxRows: Schema.natural().min(1).max(10_000).default(200),
  queryTimeoutMs: Schema.natural().min(1_000).max(600_000).default(60_000),
  poolMax: Schema.natural().min(1).max(16).default(2),
  maxCellChars: Schema.natural().min(32).max(100_000).default(1_000),
  maxOutputChars: Schema.natural().min(1_000).max(1_000_000).default(50_000),
})

/**
 * Register `oracle_schema`, `oracle_query`, and their prompt guidance, backed by one session pool
 * that opens on first use and closes, after running queries stop, when the plugin unloads.
 * @param ctx - context providing the tool and system-prompt registries.
 * @param input - the database and limits.
 */
export function apply(ctx: Context, input: Config): void {
  const config = Config(input)
  const passwordRef = credentialRef(config.passwordEnv)
  ctx.effect(function* () {
    const client = new OracleClient(oracledb, {
      connectString: config.connectString,
      user: config.user,
      passwordRef,
      callTimeoutMs: config.queryTimeoutMs,
      poolMax: config.poolMax,
      password: () => resolveCredentialRef(ctx, passwordRef),
      warn: (message) => { ctx.logger.warn(message) },
    })
    yield () => client.close()
    yield* registerOracleTools(ctx, client, {
      maxRows: config.maxRows,
      maxCellChars: config.maxCellChars,
      maxOutputChars: config.maxOutputChars,
    })
  }, 'oracle-db.runtime')
}
