import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

/** A shared local dataset store. Expiration hides records; it never erases last-good data. */
export function openPersonalStore(filename, { readOnly = false, now = Date.now } = {}) {
  if (typeof filename !== 'string' || !isAbsolute(filename)) throw new Error('Personal database path must be absolute');
  const db = new DatabaseSync(filename, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS personal_values (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          stored_at INTEGER NOT NULL,
          expires_at INTEGER
        );`);
    }
    const read = db.prepare('SELECT value, stored_at, expires_at FROM personal_values WHERE key = ?');
    const write = readOnly ? null : db.prepare(`INSERT INTO personal_values(key, value, stored_at, expires_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,
      stored_at=excluded.stored_at, expires_at=excluded.expires_at`);
    const remove = readOnly ? null : db.prepare('DELETE FROM personal_values WHERE key = ?');
    const assertWritable = () => { if (readOnly) throw new Error('Personal database is read-only'); };
    const keyCheck = key => { if (typeof key !== 'string' || !key.trim()) throw new Error('A nonempty storage key is required'); };
    function encode(key, value, ttlSeconds, timestamp) {
      keyCheck(key);
      if (ttlSeconds != null && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) throw new Error('TTL must be positive seconds or null');
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error('Stored value must be JSON serializable');
      return [key, encoded, timestamp, ttlSeconds == null ? null : timestamp + ttlSeconds * 1000];
    }
    function transaction(work) {
      assertWritable();
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    function getRecord(key) {
      keyCheck(key);
      const row = read.get(key);
      if (!row) return null;
      return { value: JSON.parse(row.value), storedAt: row.stored_at, expiresAt: row.expires_at,
        expired: row.expires_at !== null && row.expires_at <= now() };
    }
    function get(key) {
      const record = getRecord(key);
      return record && !record.expired ? record.value : null;
    }
    return {
      get,
      getRecord,
      getMany: keys => keys.map(get),
      set(key, value, ttlSeconds = null) {
        assertWritable();
        write.run(...encode(key, value, ttlSeconds, now()));
      },
      setIfAbsent(key, value, ttlSeconds = null) {
        const args = encode(key, value, ttlSeconds, now());
        return transaction(() => {
          const existing = getRecord(key);
          if (existing && !existing.expired) return false;
          write.run(...args);
          return true;
        });
      },
      delete(key) { assertWritable(); keyCheck(key); return remove.run(key).changes > 0; },
      atomicPublish({ key, value, metadata, metaKey = `seed-meta:${key}`, ttlSeconds = null, metaTtlSeconds = null }) {
        if (!metaKey.startsWith('seed-meta:') || metaKey === key) throw new Error('Seed metadata requires a distinct seed-meta: key');
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Seed metadata must be an object');
        const timestamp = now();
        // Validate/serialize both before touching either last-good record.
        const dataArgs = encode(key, value, ttlSeconds, timestamp);
        const metaArgs = encode(metaKey, metadata, metaTtlSeconds, timestamp);
        transaction(() => { write.run(...dataArgs); write.run(...metaArgs); });
      },
      close() { db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
