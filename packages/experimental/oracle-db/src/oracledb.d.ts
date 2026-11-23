/**
 * Ambient module declaration for `oracledb`, which ships no types; the plugin adds no
 * DefinitelyTyped dependency. Only the members in {@link OracleDriver} are declared.
 */
declare module 'oracledb' {
  /** node-oracledb's module object, as far as the plugin uses it. */
  const oracledb: import('./driver.ts').OracleDriver
  export default oracledb
}
