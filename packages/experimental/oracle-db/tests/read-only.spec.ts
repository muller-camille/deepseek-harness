/** The statement check that admits only one read-only query. */

import { describe, expect, it } from 'vitest'
import { OracleDbError } from '../src/error.ts'
import { checkReadOnlySql } from '../src/read-only.ts'

const RULE = 'Only a single SELECT or WITH query is allowed; statements that change data or schema, PL/SQL, and SELECT ... FOR UPDATE are refused.'

function refusal(sql: string): string {
  try {
    checkReadOnlySql(sql)
  } catch (error) {
    if (!(error instanceof OracleDbError)) throw error
    expect(error.code).toBe('ORACLE_READ_ONLY')
    expect(error.name).toBe('OracleDbError')
    return error.message
  }
  throw new Error(`accepted: ${sql}`)
}

describe('checkReadOnlySql', () => {
  it.each([
    ['SELECT 1 FROM dual', 'SELECT 1 FROM dual'],
    ['select * from employees', 'select * from employees'],
    ['  \n\tSELECT 1 FROM dual  \n', 'SELECT 1 FROM dual'],
    ['((SELECT 1 FROM dual)) UNION (SELECT 2 FROM dual)', '((SELECT 1 FROM dual)) UNION (SELECT 2 FROM dual)'],
    ['WITH totals AS (SELECT department_id, SUM(salary) s FROM employees GROUP BY department_id) SELECT * FROM totals', 'WITH totals AS (SELECT department_id, SUM(salary) s FROM employees GROUP BY department_id) SELECT * FROM totals'],
    ['(WITH x AS (SELECT 1 a FROM dual) SELECT a FROM x)', '(WITH x AS (SELECT 1 a FROM dual) SELECT a FROM x)'],
    ['SELECT 1 FROM dual;', 'SELECT 1 FROM dual'],
    ['SELECT 1 FROM dual ;  -- done\n', 'SELECT 1 FROM dual'],
    ['SELECT 1 FROM dual -- trailing note', 'SELECT 1 FROM dual -- trailing note'],
    ['/* report */ SELECT 1 FROM dual', '/* report */ SELECT 1 FROM dual'],
    ['-- report\nSELECT 1 FROM dual', '-- report\nSELECT 1 FROM dual'],
  ])('accepts %j', (sql, executed) => {
    expect(checkReadOnlySql(sql)).toBe(executed)
  })

  it.each([
    'SELECT \'a; DELETE FROM employees\' FROM dual',
    'SELECT \'it\'\'s; FOR UPDATE\' FROM dual',
    'SELECT N\'ünïcode; DROP TABLE t\' FROM dual',
    'SELECT q\'[it\'s; DELETE FROM t]\' FROM dual',
    'SELECT Q\'{a } b; FOR UPDATE}\' FROM dual',
    'SELECT nq\'<x; y>\' FROM dual',
    'SELECT NQ\'(x; y)\' FROM dual',
    'SELECT q\'!a\'; b!\' FROM dual',
    'SELECT "FOR", "UPDATE", "a;b" FROM t',
    'SELECT 1 /* ; DELETE FROM employees */ FROM dual -- ; DROP TABLE t',
    'SELECT /*+ FULL(e) */ e.name FROM employees e',
    'SELECT * FROM (SELECT department_id, salary FROM employees) PIVOT (SUM(salary) FOR department_id IN (10, 20))',
    'SELECT for_update, with_function FROM flags',
    'SELECT 名前 FROM 社員',
    'SELECT freq\'x\' FROM dual',
  ])('treats literals, quoted identifiers, and comments as opaque in %j', (sql) => {
    expect(checkReadOnlySql(sql)).toBe(sql)
  })

  it.each([
    ['DELETE FROM employees', 'it starts with DELETE, not SELECT or WITH'],
    ['insert into employees values (1)', 'it starts with INSERT'],
    ['UPDATE employees SET salary = 0', 'it starts with UPDATE'],
    ['MERGE INTO t USING s ON (1 = 1) WHEN MATCHED THEN UPDATE SET x = 1', 'it starts with MERGE'],
    ['DROP TABLE employees', 'it starts with DROP'],
    ['TRUNCATE TABLE employees', 'it starts with TRUNCATE'],
    ['GRANT SELECT ON employees TO public', 'it starts with GRANT'],
    ['ALTER SESSION SET current_schema = sys', 'it starts with ALTER'],
    ['LOCK TABLE employees IN EXCLUSIVE MODE', 'it starts with LOCK'],
    ['EXPLAIN PLAN FOR SELECT 1 FROM dual', 'it starts with EXPLAIN'],
    ['CALL dbms_output.put_line(\'x\')', 'it starts with CALL'],
    ['BEGIN DELETE FROM employees; END;', 'more than one statement'],
    ['BEGIN NULL; END', 'more than one statement'],
    ['DECLARE x NUMBER; BEGIN NULL; END;', 'more than one statement'],
    ['/* SELECT */ DELETE FROM employees', 'it starts with DELETE'],
    ['-- SELECT\nDELETE FROM employees', 'it starts with DELETE'],
    ['\'SELECT\' FROM dual', 'it starts with something other than a keyword'],
    ['"SELECT" FROM dual', 'it starts with something other than a keyword'],
    ['(((', 'it starts with something other than a keyword'],
    ['SELECT 1 FROM dual; DELETE FROM employees', 'more than one statement'],
    ['SELECT 1 FROM dual;;', 'more than one statement'],
    ['SELECT \'a\'; DELETE FROM employees --\'', 'more than one statement'],
    ['SELECT q\'{\'}\' FROM dual; DELETE FROM employees --\'', 'more than one statement'],
    ['SELECT * FROM employees FOR UPDATE', 'SELECT ... FOR UPDATE locks rows'],
    ['select * from employees for update nowait', 'FOR UPDATE'],
    ['SELECT * FROM employees FOR /* lock */ UPDATE OF salary', 'FOR UPDATE'],
    ['SELECT * FROM employees FOR\n-- lock\nUPDATE SKIP LOCKED', 'FOR UPDATE'],
    ['WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual', 'more than one statement'],
    ['WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1 END SELECT f FROM dual', 'WITH FUNCTION declares PL/SQL'],
    ['with procedure p is begin null end select 1 from dual', 'WITH PROCEDURE declares PL/SQL'],
    ['SELECT /*+ WITH_PLSQL */ * FROM (WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1 END SELECT f() v FROM dual)', 'WITH FUNCTION'],
    ['', 'the SQL contains no statement'],
    ['   \n ', 'the SQL contains no statement'],
    ['-- nothing here', 'the SQL contains no statement'],
    [';', 'the SQL contains no statement'],
    ['SELECT \'open FROM dual', 'a string literal is not closed'],
    ['SELECT "open FROM dual', 'a quoted identifier is not closed'],
    ['SELECT 1 FROM dual /* open', 'a /* comment is not closed'],
    ['SELECT q\'[open FROM dual', 'a q-quoted string literal is not closed'],
    ['SELECT q\'[open]', 'a q-quoted string literal is not closed'],
    ['SELECT q\' x \' FROM dual', 'a q-quoted string literal has no delimiter'],
    ['SELECT q\'', 'a q-quoted string literal has no delimiter'],
  ])('refuses %j', (sql, reason) => {
    const message = refusal(sql)
    expect(message).toContain(reason)
    expect(message.startsWith('oracle_query refused the SQL: ')).toBe(true)
    expect(message.endsWith(`. ${RULE}`)).toBe(true)
  })
})
