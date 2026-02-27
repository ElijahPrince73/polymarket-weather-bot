import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { BASE_BANKROLL, DB_PATH } from "./config.js";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const sqlite = new Database(DB_PATH);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY,
    city TEXT,
    station TEXT,
    question TEXT,
    market_url TEXT,
    event_date TEXT,
    side TEXT CHECK (side IN ('YES', 'NO') OR side IS NULL),
    entry_price REAL,
    model_prob REAL,
    edge REAL,
    size_pct REAL,
    stake_usd REAL,
    status TEXT CHECK (status IN ('OPEN', 'SKIP', 'SWITCHED', 'STOP', 'RESOLVED')),
    result TEXT CHECK (result IN ('PENDING', 'WIN', 'LOSS')),
    pnl REAL,
    notes TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS calibration (
    id INTEGER PRIMARY KEY,
    city TEXT,
    market_type TEXT,
    bias REAL,
    updated_at TEXT,
    UNIQUE(city, market_type)
  );
`);

const insertTradeStmt = sqlite.prepare(`
  INSERT INTO trades (
    city, station, question, market_url, event_date, side, entry_price, model_prob, edge,
    size_pct, stake_usd, status, result, pnl, notes, resolved_at
  )
  VALUES (
    @city, @station, @question, @market_url, @event_date, @side, @entry_price, @model_prob, @edge,
    @size_pct, @stake_usd, @status, @result, @pnl, @notes, @resolved_at
  )
`);

export function insertTrade(trade) {
  const row = {
    city: trade.city ?? null,
    station: trade.station ?? null,
    question: trade.question ?? null,
    market_url: trade.market_url ?? null,
    event_date: trade.event_date ?? null,
    side: trade.side ?? null,
    entry_price: trade.entry_price ?? null,
    model_prob: trade.model_prob ?? null,
    edge: trade.edge ?? null,
    size_pct: trade.size_pct ?? null,
    stake_usd: trade.stake_usd ?? null,
    status: trade.status ?? "SKIP",
    result: trade.result ?? "PENDING",
    pnl: trade.pnl ?? null,
    notes: trade.notes ?? null,
    resolved_at: trade.resolved_at ?? null,
  };
  return insertTradeStmt.run(row);
}

const updatableColumns = new Set([
  "city",
  "station",
  "question",
  "market_url",
  "event_date",
  "side",
  "entry_price",
  "model_prob",
  "edge",
  "size_pct",
  "stake_usd",
  "status",
  "result",
  "pnl",
  "notes",
  "resolved_at",
]);

export function updateTrade(id, updates) {
  const entries = Object.entries(updates).filter(([key]) => updatableColumns.has(key));
  if (!entries.length) return;
  const setSql = entries.map(([key]) => `${key}=@${key}`).join(", ");
  const stmt = sqlite.prepare(`UPDATE trades SET ${setSql} WHERE id=@id`);
  const params = Object.fromEntries(entries);
  params.id = id;
  return stmt.run(params);
}

export function getOpenTrades() {
  return sqlite.prepare(`SELECT * FROM trades WHERE status='OPEN'`).all();
}

export function getTradesByCityDate(city, date) {
  return sqlite.prepare(`SELECT * FROM trades WHERE city=? AND event_date=? ORDER BY created_at DESC`).all(city, date);
}

export function getTodayResolvedPnl(todayIso = new Date().toISOString().slice(0, 10)) {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(pnl), 0) AS pnl
       FROM trades
       WHERE result IN ('WIN', 'LOSS')
         AND resolved_at IS NOT NULL
         AND substr(resolved_at, 1, 10)=?`
    )
    .get(todayIso);
  return row?.pnl ?? 0;
}

export function getBankroll() {
  const row = sqlite
    .prepare(`SELECT COALESCE(SUM(pnl), 0) AS realized_pnl FROM trades WHERE result IN ('WIN', 'LOSS')`)
    .get();
  return BASE_BANKROLL + (row?.realized_pnl ?? 0);
}

export function getAllResolved() {
  return sqlite.prepare(`SELECT * FROM trades WHERE result IN ('WIN', 'LOSS') ORDER BY resolved_at DESC`).all();
}

export function getCalibration(city, marketType) {
  return sqlite
    .prepare(`SELECT * FROM calibration WHERE city=? AND market_type=?`)
    .get(city, marketType);
}

export function upsertCalibration(city, marketType, bias, updatedAt = new Date().toISOString()) {
  return sqlite
    .prepare(
      `INSERT INTO calibration (city, market_type, bias, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(city, market_type)
       DO UPDATE SET bias=excluded.bias, updated_at=excluded.updated_at`
    )
    .run(city, marketType, bias, updatedAt);
}

const db = {
  sqlite,
  insertTrade,
  updateTrade,
  getOpenTrades,
  getTradesByCityDate,
  getTodayResolvedPnl,
  getBankroll,
  getAllResolved,
  getCalibration,
  upsertCalibration,
};

export default db;
