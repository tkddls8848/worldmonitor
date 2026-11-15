// Public entry for the intel-history SQLite store. The implementation lives
// in scripts/lib/ so collectors can reach it without importing outside
// scripts/ (tests/scripts-railway-nixpacks-no-escape-import.test.mts).
export * from '../scripts/lib/intel-history-store.mjs';
