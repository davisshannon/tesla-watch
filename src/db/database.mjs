import Database from "better-sqlite3";
import path from "path";
import { mkdir } from "fs/promises";

let _db = null;

export async function openDb(dbFile) {
  if (_db) return _db;
  await mkdir(path.dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  _db = db;
  return db;
}

export function getDb() {
  if (!_db) throw new Error("Database not opened. Call openDb() first.");
  return _db;
}

function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watches (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      model      TEXT NOT NULL,
      category   TEXT NOT NULL DEFAULT '',
      label      TEXT NOT NULL,
      market     TEXT NOT NULL DEFAULT 'en_AU',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id      INTEGER NOT NULL REFERENCES watches(id),
      ran_at        TEXT NOT NULL DEFAULT (datetime('now')),
      status        TEXT NOT NULL,
      vehicle_count INTEGER NOT NULL DEFAULT 0,
      added         INTEGER NOT NULL DEFAULT 0,
      removed       INTEGER NOT NULL DEFAULT 0,
      updated       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id           TEXT NOT NULL,
      watch_id     INTEGER NOT NULL REFERENCES watches(id),
      vin          TEXT NOT NULL DEFAULT '',
      model        TEXT NOT NULL DEFAULT '',
      trim         TEXT NOT NULL DEFAULT '',
      year         TEXT NOT NULL DEFAULT '',
      exterior     TEXT NOT NULL DEFAULT '',
      interior     TEXT NOT NULL DEFAULT '',
      wheels       TEXT NOT NULL DEFAULT '',
      location     TEXT NOT NULL DEFAULT '',
      city         TEXT NOT NULL DEFAULT '',
      price        TEXT NOT NULL DEFAULT '',
      subtotal     TEXT NOT NULL DEFAULT '',
      odometer     TEXT NOT NULL DEFAULT '',
      inventory_id TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
      removed_at    TEXT,
      raw_json      TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (id, watch_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id    INTEGER NOT NULL REFERENCES watches(id),
      vehicle_id  TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      price       TEXT,
      prior_price TEXT,
      notified    INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vehicles_watch ON vehicles(watch_id);
    CREATE INDEX IF NOT EXISTS idx_runs_watch ON runs(watch_id, ran_at DESC);
  `);
}

// ── Watch registry ─────────────────────────────────────────────────────────

export function upsertWatch(db, { model, category, label, market }) {
  const existing = db
    .prepare("SELECT id FROM watches WHERE model = ? AND category = ? AND market = ?")
    .get(model, category ?? "", market ?? "en_AU");
  if (existing) return existing.id;
  const info = db
    .prepare("INSERT INTO watches (model, category, label, market) VALUES (?, ?, ?, ?)")
    .run(model, category ?? "", label, market ?? "en_AU");
  return info.lastInsertRowid;
}

// ── State replacement — seenIds from active vehicles ──────────────────────

export function getSeenIds(db, watchId) {
  const rows = db
    .prepare("SELECT id, price, trim, exterior, interior FROM vehicles WHERE watch_id = ? AND removed_at IS NULL")
    .all(watchId);
  const seenIds = {};
  for (const r of rows) {
    seenIds[r.id] = { price: r.price, trim: r.trim, exterior: r.exterior, interior: r.interior };
  }
  return seenIds;
}

// ── Vehicle upsert ─────────────────────────────────────────────────────────

export function upsertVehicles(db, watchId, vehicles, vehicleIdFn) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO vehicles
      (id, watch_id, vin, model, trim, year, exterior, interior, wheels,
       location, city, price, subtotal, odometer, inventory_id, first_seen_at, last_seen_at, removed_at, raw_json)
    VALUES
      (@id, @watch_id, @vin, @model, @trim, @year, @exterior, @interior, @wheels,
       @location, @city, @price, @subtotal, @odometer, @inventory_id, @now, @now, NULL, @raw_json)
    ON CONFLICT(id, watch_id) DO UPDATE SET
      price        = excluded.price,
      subtotal     = excluded.subtotal,
      odometer     = excluded.odometer,
      last_seen_at = excluded.last_seen_at,
      removed_at   = NULL,
      raw_json     = excluded.raw_json
  `);

  const upsertMany = db.transaction((vs) => {
    for (const v of vs) {
      stmt.run({
        id: vehicleIdFn(v),
        watch_id: watchId,
        vin: v.vin ?? "",
        model: v.model ?? "",
        trim: v.trim ?? "",
        year: String(v.year ?? ""),
        exterior: v.exterior ?? "",
        interior: v.interior ?? "",
        wheels: v.wheels ?? "",
        location: v.location ?? "",
        city: v.city ?? "",
        price: String(v.price ?? ""),
        subtotal: String(v.subtotal ?? ""),
        odometer: String(v.odometer ?? ""),
        inventory_id: v.inventoryId ?? "",
        now,
        raw_json: JSON.stringify(v.raw ?? {}),
      });
    }
  });
  upsertMany(vehicles);
}

// ── Mark removed vehicles ──────────────────────────────────────────────────

export function markRemoved(db, watchId, removedIds) {
  if (!removedIds.length) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    "UPDATE vehicles SET removed_at = ? WHERE watch_id = ? AND id = ? AND removed_at IS NULL"
  );
  const markAll = db.transaction((ids) => {
    for (const id of ids) stmt.run(now, watchId, id);
  });
  markAll(removedIds);
}

// ── Event recording ────────────────────────────────────────────────────────

export function recordEvents(db, watchId, { added, removed, updated }, notified) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO events (watch_id, vehicle_id, event_type, occurred_at, price, prior_price, notified)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Get last-known prices for removed vehicles
  const priceOf = {};
  if (removed.length) {
    const placeholders = removed.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id, price FROM vehicles WHERE watch_id = ? AND id IN (${placeholders})`)
      .all(watchId, ...removed);
    for (const r of rows) priceOf[r.id] = r.price;
  }

  const insertAll = db.transaction(() => {
    for (const v of added) {
      stmt.run(watchId, v._id, "added", now, String(v.price ?? ""), null, notified ? 1 : 0);
    }
    for (const id of removed) {
      stmt.run(watchId, id, "removed", now, priceOf[id] ?? null, null, 0);
    }
    for (const { vehicle, priorPrice } of updated) {
      stmt.run(watchId, vehicle._id, "price_drop", now, String(vehicle.price ?? ""), String(priorPrice ?? ""), notified ? 1 : 0);
    }
  });
  insertAll();
}

// ── Run record ─────────────────────────────────────────────────────────────

export function recordRun(db, watchId, { status, vehicleCount, added, removed, updated }) {
  return db
    .prepare(`
      INSERT INTO runs (watch_id, status, vehicle_count, added, removed, updated)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(watchId, status, vehicleCount, added, removed, updated).lastInsertRowid;
}

// ── Web API queries ────────────────────────────────────────────────────────

export function queryVehicles(db, { watchId, active, trim, limit = 200, offset = 0 } = {}) {
  let where = "1=1";
  const params = [];
  if (watchId != null) { where += " AND v.watch_id = ?"; params.push(watchId); }
  if (active === true)  { where += " AND v.removed_at IS NULL"; }
  if (active === false) { where += " AND v.removed_at IS NOT NULL"; }
  if (trim) { where += " AND v.trim LIKE ?"; params.push(`%${trim}%`); }
  return db.prepare(`
    SELECT v.*, w.label as watch_label, w.model as watch_model
    FROM vehicles v
    JOIN watches w ON w.id = v.watch_id
    WHERE ${where}
    ORDER BY v.last_seen_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

export function queryDistinctTrims(db, { watchId } = {}) {
  let where = "v.trim != ''";
  const params = [];
  if (watchId != null) { where += " AND v.watch_id = ?"; params.push(watchId); }
  return db.prepare(`
    SELECT DISTINCT v.trim, w.model as watch_model
    FROM vehicles v
    JOIN watches w ON w.id = v.watch_id
    WHERE ${where}
    ORDER BY w.model, v.trim
  `).all(...params);
}

export function queryEvents(db, { watchId, type, limit = 100, offset = 0 } = {}) {
  let where = "1=1";
  const params = [];
  if (watchId != null) { where += " AND e.watch_id = ?"; params.push(watchId); }
  if (type)            { where += " AND e.event_type = ?"; params.push(type); }
  return db.prepare(`
    SELECT e.*, w.label as watch_label
    FROM events e
    JOIN watches w ON w.id = e.watch_id
    WHERE ${where}
    ORDER BY e.occurred_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

export function queryRuns(db, { watchId, limit = 50 } = {}) {
  let where = "1=1";
  const params = [];
  if (watchId != null) { where += " AND r.watch_id = ?"; params.push(watchId); }
  return db.prepare(`
    SELECT r.*, w.label as watch_label
    FROM runs r
    JOIN watches w ON w.id = r.watch_id
    WHERE ${where}
    ORDER BY r.ran_at DESC
    LIMIT ?
  `).all(...params, limit);
}

export function queryStockHistory(db, { watchId, days = 30 } = {}) {
  const params = [];
  let watchFilter = "";
  if (watchId != null) { watchFilter = "AND watch_id = ?"; params.push(watchId); }
  return db.prepare(`
    SELECT
      date(ran_at) as date,
      watch_id,
      AVG(vehicle_count) as avg_count,
      MAX(vehicle_count) as max_count,
      MIN(vehicle_count) as min_count,
      SUM(added) as total_added,
      SUM(removed) as total_removed
    FROM runs
    WHERE ran_at >= datetime('now', '-${days} days')
    ${watchFilter}
    GROUP BY date(ran_at), watch_id
    ORDER BY date ASC
  `).all(...params);
}

export function queryAllWatches(db) {
  return db.prepare("SELECT * FROM watches ORDER BY id").all();
}

export function queryCurrentStatus(db, { state } = {}) {
  const stateFilter = state ? "AND location = ?" : "";
  const params = state ? [state] : [];
  return db.prepare(`
    SELECT
      w.id, w.label, w.model, w.category, w.market,
      (SELECT COUNT(*) FROM vehicles WHERE watch_id = w.id AND removed_at IS NULL ${stateFilter}) as active_count,
      (SELECT ran_at FROM runs WHERE watch_id = w.id ORDER BY ran_at DESC LIMIT 1) as last_run,
      (SELECT status FROM runs WHERE watch_id = w.id ORDER BY ran_at DESC LIMIT 1) as last_status
    FROM watches w
    ORDER BY w.id
  `).all(...params);
}

export function queryDistinctStates(db) {
  return db.prepare("SELECT DISTINCT location FROM vehicles WHERE location != '' ORDER BY location").all().map(r => r.location);
}

export function queryStockByState(db) {
  return db.prepare(`
    SELECT v.location, w.model, COUNT(*) as count
    FROM vehicles v
    JOIN watches w ON w.id = v.watch_id
    WHERE v.removed_at IS NULL AND v.location != ''
    GROUP BY v.location, w.model
    ORDER BY v.location, w.model
  `).all();
}
