import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { Provider, Settings, Log, PublicKey } from '../schemas/types';
import type { Route } from '../../routing/schemas/types';
import {
  providerView,
  readLog,
  secretMissingError,
  withRuledKeyTail,
  type LegacyLog,
} from '../functions/admin';
import {
  seedProviders,
  typeSafeProvider,
  typeSafeSeedName,
  seedRoutes,
  migrateOpenRouterPath,
  migrateProviderOptions,
  retireSeededProvider,
  planChatSeeds,
  CHAT_SEEDS,
} from '../functions/seed';

const json = (x: unknown) => JSON.stringify(x);

const parse = <T>(s: string): T => JSON.parse(s) as T;

export const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

export const now = () => new Date().toISOString();

export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest(),
    y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

export class Store {
  db: Database;

  // log takes the startup lines a migration writes.
  constructor(
    dir: string,
    private env: NodeJS.ProcessEnv = process.env,
    private log: (line: string) => void = (line) => console.log(line),
  ) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'gateway.db'), { create: true });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;

      CREATE TABLE IF NOT EXISTS migrations (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        alias TEXT UNIQUE NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        last4 TEXT NOT NULL,
        created TEXT NOT NULL,
        last_used TEXT
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
      INSERT OR IGNORE INTO migrations VALUES(1);
    `);
    this.seed();
    this.migrate();
  }

  close() {
    this.db.close();
  }

  seed() {
    if (this.db.query('SELECT id FROM settings WHERE id=1').get()) return;
    this.db.transaction(() => {
      const t = now();
      const providers = seedProviders(
        t,
        Array.from({ length: 5 + CHAT_SEEDS.length }, () => id('prv')),
      );
      providers.forEach((p) => this.putProvider(p));
      const ids = Object.fromEntries(providers.map((p) => [p.name, p.id]));
      seedRoutes(
        t,
        ids,
        Array.from({ length: 3 }, () => id('rte')),
      ).forEach((r) => this.putRoute(r));
      this.setSettings({
        require_client_keys: false,
        capture_payloads: false,
        default_route: 'default',
      });
    })();
  }

  migrate() {
    this.migrateProviders(2, migrateOpenRouterPath);
    this.migrateProviders(3, migrateProviderOptions);
    this.once(4, () => {
      // Replaced by migration 5.
    });
    this.once(5, () => this.retireSeededProvider());
    this.once(6, () => {
      const name = typeSafeSeedName(this.providers());
      if (name) this.putProvider(typeSafeProvider(now(), id('prv'), name));
    });
    this.once(7, () => {
      const plan = planChatSeeds(
        this.providers(),
        now(),
        CHAT_SEEDS.map(() => id('prv')),
      );
      plan.add.forEach((p) => this.putProvider(p));
      plan.log.forEach((line) => this.log(line));
    });
    // A stored key written before keyTail's rule keeps its last four characters whatever its length, so a short key's
    // last4 may be all or most of it: each is recomputed from the decrypted key, or, when it cannot be decrypted, kept
    // only for a ciphertext long enough to prove the key has at least KEY_TAIL_MIN_LENGTH characters.
    this.migrateProviders(8, (p) =>
      withRuledKeyTail(p, this.plainStoredKey(p), this.storedKeyBytes(p)),
    );
  }

  // The length in bytes of a provider's stored key, read from its ciphertext (salt, IV and auth tag, then the
  // encrypted key, which is as long as the key), or null when it has no stored key or the ciphertext is too short.
  private storedKeyBytes(p: Provider): number | null {
    if (p.key.source !== 'stored') return null;
    const bytes = Buffer.from(p.key.ciphertext, 'base64').length - 44;
    return bytes >= 0 ? bytes : null;
  }

  // The decrypted stored key of a provider, or null when it has none or it cannot be decrypted, as when
  // GATEWAY_SECRET is unset or has changed.
  private plainStoredKey(p: Provider): string | null {
    if (p.key.source !== 'stored') return null;
    try {
      return this.decrypt(p.key.ciphertext);
    } catch {
      return null;
    }
  }

  // Runs a migration once, in a transaction, and records its version. It returns what the migration returns, or null
  // when it already ran.
  private once<T>(version: number, run: () => T): T | null {
    return this.db.transaction(() => {
      if (this.db.query('SELECT version FROM migrations WHERE version=?').get(version)) return null;
      const result = run();
      this.db.query('INSERT INTO migrations(version) VALUES(?)').run(version);
      return result;
    })();
  }

  // Runs one provider migration once: each provider it changes is written back.
  private migrateProviders(version: number, change: (provider: Provider) => Provider) {
    this.once(version, () => {
      for (const provider of this.providers()) {
        const migrated = change(provider);
        if (migrated !== provider) this.putProvider(migrated);
      }
    });
  }

  // Migration 5 applies the pure plan inside once's transaction: move routes, delete the provider, then log.
  private retireSeededProvider() {
    const plan = retireSeededProvider(this.providers(), this.routes());
    for (const route of plan.routes) this.putRoute(route);
    if (plan.remove) this.deleteProvider(plan.remove);
    if (plan.log) this.log(plan.log);
  }

  providers(): Provider[] {
    return (
      this.db.query('SELECT data FROM providers ORDER BY rowid').all() as { data: string }[]
    ).map((x) => parse(x.data));
  }

  putProvider(p: Provider) {
    this.db
      .query(
        'INSERT INTO providers(id,name,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data',
      )
      .run(p.id, p.name, json(p));
  }

  deleteProvider(id: string) {
    this.db.query('DELETE FROM providers WHERE id=?').run(id);
  }

  routes(): Route[] {
    return (
      this.db.query('SELECT data FROM routes ORDER BY rowid').all() as { data: string }[]
    ).map((x) => parse(x.data));
  }

  putRoute(r: Route) {
    this.db
      .query(
        'INSERT INTO routes(id,alias,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,data=excluded.data',
      )
      .run(r.id, r.alias, json(r));
  }

  deleteRoute(id: string) {
    this.db.query('DELETE FROM routes WHERE id=?').run(id);
  }

  settings(): Settings {
    return parse(
      (this.db.query('SELECT data FROM settings WHERE id=1').get() as { data: string }).data,
    );
  }

  setSettings(s: Settings) {
    this.db
      .query(
        'INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(json(s));
  }

  // Whether GATEWAY_SECRET is set. The health report carries this fact and never the value.
  secretConfigured(): boolean {
    return !!this.env.GATEWAY_SECRET;
  }

  encrypt(value: string): string {
    const secret = this.env.GATEWAY_SECRET;
    if (!secret) throw secretMissingError();
    const salt = randomBytes(16),
      iv = randomBytes(12),
      key = scryptSync(secret, salt, 32),
      c = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return Buffer.concat([salt, iv, c.getAuthTag(), ciphertext]).toString('base64');
  }

  decrypt(value: string): string {
    const secret = this.env.GATEWAY_SECRET;
    if (!secret) throw new Error('GATEWAY_SECRET is not set');
    const b = Buffer.from(value, 'base64'),
      d = createDecipheriv(
        'aes-256-gcm',
        scryptSync(secret, b.subarray(0, 16), 32),
        b.subarray(16, 28),
      );
    d.setAuthTag(b.subarray(28, 44));
    return Buffer.concat([d.update(b.subarray(44)), d.final()]).toString('utf8');
  }

  key(p: Provider): string | null {
    if (p.key.source === 'none') return null;
    if (p.key.source === 'env') return this.env[p.key.env_var] || null;
    return this.decrypt(p.key.ciphertext);
  }

  publicProvider(p: Provider): Omit<Provider, 'key'> & { key: PublicKey } {
    const present = p.key.source === 'env' && !!this.env[p.key.env_var];
    return providerView(p, present);
  }

  clients() {
    return this.db
      .query(
        'SELECT id,name,last4 AS key_last4,created AS created_at,last_used AS last_used_at FROM clients ORDER BY rowid DESC',
      )
      .all();
  }

  createClient(name: string) {
    const key = `dgk_${randomBytes(32).toString('base64url')}`,
      client = { id: id('cli'), name, key, key_last4: key.slice(-4), created_at: now() };
    this.db
      .query('INSERT INTO clients(id,name,hash,last4,created) VALUES(?,?,?,?,?)')
      .run(
        client.id,
        name,
        createHash('sha256').update(key).digest('hex'),
        client.key_last4,
        client.created_at,
      );
    return client;
  }

  deleteClient(id: string) {
    return this.db.query('DELETE FROM clients WHERE id=?').run(id).changes > 0;
  }

  authenticateClient(key: string) {
    const hash = createHash('sha256').update(key).digest('hex');
    const row = this.db.query('SELECT id FROM clients WHERE hash=?').get(hash) as {
      id: string;
    } | null;
    if (!row) return false;
    this.db.query('UPDATE clients SET last_used=? WHERE id=?').run(now(), row.id);
    return true;
  }

  addLog(log: Log) {
    this.db.query('INSERT INTO logs(id,ts,data) VALUES(?,?,?)').run(log.id, log.ts, json(log));
  }

  allLogs(): Log[] {
    return (
      this.db.query('SELECT data FROM logs ORDER BY rowid DESC').all() as { data: string }[]
    ).map((x) => readLog(parse<LegacyLog>(x.data)));
  }
}
