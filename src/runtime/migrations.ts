/**
 * Tiny schema-migration runner shared across DOs. Each DO owns its own
 * `MIGRATIONS` list and calls `runMigrations(sql, list)` from its constructor.
 *
 * Conventions:
 *  - Migrations are append-only — never mutate or delete an existing entry,
 *    since deployed DOs may already have applied it.
 *  - Each migration is a `{ version, up }` pair. Versions must be strictly
 *    increasing integers starting at 1.
 *  - The current applied version is stored in `settings.schema_version`.
 *  - The settings table itself is bootstrapped here so migrations have a
 *    place to record the version even on a fresh DO.
 */

export interface Migration {
  version: number;
  up: (sql: SqlStorage) => void;
}

export function runMigrations(sql: SqlStorage, migrations: readonly Migration[]): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const row = sql
    .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'schema_version'")
    .toArray()[0];
  const current = row ? Number(row.value) || 0 : 0;
  // Run each migration in its own transaction together with the
  // schema_version bump, so a partial migration can't leave the DO with
  // half-applied DDL but an unchanged schema_version (which would cause
  // the broken migration to re-run on next cold start).
  for (const m of migrations) {
    if (m.version <= current) continue;
    sql.exec('BEGIN');
    try {
      m.up(sql);
      sql.exec(
        "INSERT INTO settings (key, value, updated_at) VALUES ('schema_version', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
        String(m.version), Date.now()
      );
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }
  }
}
