/**
 * Statement check for model-written SQL. It tokenizes Oracle SQL, skipping comments and treating string
 * literals (including `q'[...]'` and `N'...'`) and quoted identifiers as opaque, so text inside them cannot
 * hide or fake a keyword or a statement separator. The check is the first of two read-only layers; the
 * read-only transaction in the client is the second.
 * @module
 */

import { OracleDbError } from './error.ts'

interface Token {
  readonly kind: 'word' | 'symbol' | 'literal'
  /** Uppercased word or the symbol character; empty for a literal. */
  readonly text: string
  /** Offset of the token's first character in the statement. */
  readonly start: number
}

const WORD = /[\p{L}\p{N}_$#]/u
const WHITESPACE = /\s/u
const Q_QUOTE_CLOSERS: Readonly<Record<string, string>> = { '[': ']', '{': '}', '(': ')', '<': '>' }

/**
 * Refuse `sql` with the reason the model reads.
 * @param reason - why the statement is not one read-only query.
 * @returns never; always throws.
 */
function refuse(reason: string): never {
  throw new OracleDbError(
    `oracle_query refused the SQL: ${reason}. Only a single SELECT or WITH query is allowed; statements that change data or schema, PL/SQL, and SELECT ... FOR UPDATE are refused.`,
    'ORACLE_READ_ONLY',
  )
}

/**
 * End offset of the literal or quoted identifier that starts at `start`.
 * @param sql - the statement.
 * @param start - offset of the opening `'` or `"`.
 * @returns offset just past the closing quote.
 */
function quotedEnd(sql: string, start: number): number {
  const quote = sql.charAt(start)
  let index = start + 1
  while (true) {
    const close = sql.indexOf(quote, index)
    if (close < 0) refuse(quote === '"' ? 'a quoted identifier is not closed' : 'a string literal is not closed')
    // Two quotes inside a string literal stand for one quote character.
    if (quote === '\'' && sql.charAt(close + 1) === '\'') {
      index = close + 2
      continue
    }
    return close + 1
  }
}

/**
 * End offset of the alternative-quoting literal `q'<d>...<d>'` whose opening quote is at `quote`.
 * @param sql - the statement.
 * @param quote - offset of the `'` after `q`.
 * @returns offset just past the closing quote.
 */
function alternativeQuotedEnd(sql: string, quote: number): number {
  const delimiter = sql.charAt(quote + 1)
  if (delimiter === '' || WHITESPACE.test(delimiter)) refuse('a q-quoted string literal has no delimiter')
  const closer = `${Q_QUOTE_CLOSERS[delimiter] ?? delimiter}'`
  const close = sql.indexOf(closer, quote + 2)
  if (close < 0) refuse('a q-quoted string literal is not closed')
  return close + closer.length
}

/**
 * Offset of the `'` that opens a q-quoted literal starting at `start` (`q'`, `Q'`, `nq'`, `NQ'`), if one does.
 * @param sql - the statement.
 * @param start - offset of the current token's first character.
 * @returns the quote's offset, or `undefined` when no q-quoted literal starts here.
 */
function alternativeQuoteAt(sql: string, start: number): number | undefined {
  const first = sql.charAt(start).toLowerCase()
  if (first === 'q' && sql.charAt(start + 1) === '\'') return start + 1
  if (first === 'n' && sql.charAt(start + 1).toLowerCase() === 'q' && sql.charAt(start + 2) === '\'') return start + 2
  return undefined
}

/**
 * Split a statement into words, symbols, and opaque literals, dropping whitespace and comments.
 * @param sql - the statement.
 * @returns the tokens in order.
 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql.charAt(index)
    const alternativeQuote = alternativeQuoteAt(sql, index)
    if (WHITESPACE.test(char)) {
      index += 1
    } else if (sql.startsWith('--', index)) {
      const newline = sql.indexOf('\n', index)
      index = newline < 0 ? sql.length : newline + 1
    } else if (sql.startsWith('/*', index)) {
      const close = sql.indexOf('*/', index + 2)
      if (close < 0) refuse('a /* comment is not closed')
      index = close + 2
    } else if (char === '\'' || char === '"') {
      tokens.push({ kind: 'literal', text: '', start: index })
      index = quotedEnd(sql, index)
    } else if (alternativeQuote !== undefined) {
      tokens.push({ kind: 'literal', text: '', start: index })
      index = alternativeQuotedEnd(sql, alternativeQuote)
    } else if (WORD.test(char)) {
      let end = index + 1
      while (end < sql.length && WORD.test(sql.charAt(end))) end += 1
      tokens.push({ kind: 'word', text: sql.slice(index, end).toUpperCase(), start: index })
      index = end
    } else {
      tokens.push({ kind: 'symbol', text: char, start: index })
      index += 1
    }
  }
  return tokens
}

/**
 * Accept one read-only query and return the text to execute. The statement must start, after any
 * opening parentheses, with `SELECT` or `WITH`; it must contain no `;` except one at the end, which
 * is removed; and it must not contain `FOR UPDATE` or a `WITH FUNCTION` / `WITH PROCEDURE` PL/SQL
 * declaration. Comments and literals cannot satisfy or evade these rules.
 * @param sql - the model's SQL.
 * @returns the statement without its trailing `;` and surrounding whitespace.
 * @throws OracleDbError `ORACLE_READ_ONLY` naming the rule the statement breaks.
 */
export function checkReadOnlySql(sql: string): string {
  const tokens = tokenize(sql)
  const last = tokens.at(-1)
  const terminated = last?.kind === 'symbol' && last.text === ';'
  if (terminated) tokens.pop()
  const end = terminated ? last.start : sql.length
  if (tokens.length === 0) refuse('the SQL contains no statement')
  if (tokens.some(token => token.kind === 'symbol' && token.text === ';')) refuse('it contains more than one statement')
  const first = tokens.find(token => !(token.kind === 'symbol' && token.text === '('))
  if (first?.kind !== 'word' || (first.text !== 'SELECT' && first.text !== 'WITH')) {
    refuse(`it starts with ${first?.kind === 'word' ? first.text : 'something other than a keyword'}, not SELECT or WITH`)
  }
  tokens.forEach((token, index) => {
    const next = tokens[index + 1]
    if (token.kind !== 'word' || next?.kind !== 'word') return
    if (token.text === 'FOR' && next.text === 'UPDATE') refuse('SELECT ... FOR UPDATE locks rows')
    if (token.text === 'WITH' && (next.text === 'FUNCTION' || next.text === 'PROCEDURE')) refuse(`WITH ${next.text} declares PL/SQL`)
  })
  return sql.slice(0, end).trim()
}
