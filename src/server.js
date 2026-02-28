import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import db from "./db.js";
import * as config from "./config.js";
import { runMonitor } from "./services/monitor.js";
import { dailySummary, rollingReport } from "./services/reporter.js";
import { runResolver } from "./services/resolver.js";
import { runTradeDiscovery } from "./services/trader.js";
import { cancelOrder, getBalance, getOpenOrders, isLiveMode } from "./services/exchange.js";

const app = express();
const port = Number.parseInt(process.env.PORT || "3001", 10);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..", "public");

const startedAt = Date.now();
const tickIntervalMs = 30 * 60 * 1000;
const tradingEnabled = config.MIN_EDGE >= 0;
let displayTradingMode = isLiveMode() ? "live" : "paper";
let lastTickAt = null;
let lastTickResult = null;
let tickInFlight = null;

app.use(express.json());
app.use(express.static(publicDir));

function getTradeRows(status) {
  if (status) {
    return db.sqlite.prepare(`SELECT * FROM trades WHERE status = ? ORDER BY id DESC`).all(status);
  }
  return db.sqlite.prepare(`SELECT * FROM trades ORDER BY id DESC`).all();
}

async function runTickCycle() {
  if (tickInFlight) return tickInFlight;
  tickInFlight = (async () => {
    const trade = await runTradeDiscovery(db);
    const monitor = await runMonitor(db);
    const resolve = await runResolver(db);
    const summary = {
      daily: dailySummary(),
      rolling: rollingReport(db, 30),
    };
    lastTickAt = new Date().toISOString();
    lastTickResult = { trade, monitor, resolve, summary };
    return lastTickResult;
  })().finally(() => {
    tickInFlight = null;
  });
  return tickInFlight;
}

app.get("/api/status", async (_req, res) => {
  const live = isLiveMode();
  const bankroll = await db.getBankroll();
  const liveBalance = live ? await getBalance() : null;
  res.json({
    tradingEnabled,
    tradingMode: displayTradingMode,
    envTradingMode: live ? "live" : "paper",
    bankroll,
    liveBalance,
    openTrades: db.getOpenTrades().length,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    lastTickAt,
  });
});

app.get("/api/trades", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  res.json(getTradeRows(status));
});

app.get("/api/trades/:id", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid trade id" });
    return;
  }
  const row = db.sqlite.prepare(`SELECT * FROM trades WHERE id = ?`).get(id);
  if (!row) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(row);
});

app.get("/api/summary", (_req, res) => {
  res.json({
    daily: dailySummary(),
    rolling: rollingReport(db, 30),
  });
});

app.get("/api/calibration", (_req, res) => {
  const rows = db.sqlite.prepare(`SELECT * FROM calibration ORDER BY city, market_type`).all();
  res.json(rows);
});

app.post("/api/tick", async (_req, res) => {
  try {
    const result = await runTickCycle();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error?.message || "Tick failed" });
  }
});

app.post("/api/mode", (req, res) => {
  const mode = String(req.body?.mode || "").toLowerCase();
  if (mode !== "paper" && mode !== "live") {
    res.status(400).json({ error: 'Mode must be "paper" or "live"' });
    return;
  }
  displayTradingMode = mode;
  res.json({
    ok: true,
    tradingMode: displayTradingMode,
    envTradingMode: isLiveMode() ? "live" : "paper",
    note: "Display mode updated. Actual trading mode is controlled by TRADING_MODE env.",
  });
});

app.post("/api/kill", async (_req, res) => {
  try {
    const orders = await getOpenOrders();
    const cancelled = [];
    const cancelErrors = [];
    for (const order of orders) {
      const id = order?.id ?? order?.orderID ?? order?.orderId;
      if (!id) continue;
      const result = await cancelOrder(id);
      if (result.success) cancelled.push(id);
      else cancelErrors.push({ id, error: result.error });
    }

    const skipped = db.sqlite
      .prepare(
        `UPDATE trades
         SET status='SKIP',
             notes=COALESCE(notes, '') || ' | KILL switch ' || CURRENT_TIMESTAMP
         WHERE status='OPEN'`
      )
      .run();

    res.json({
      ok: true,
      openOrdersFound: orders.length,
      cancelledCount: cancelled.length,
      cancelErrors,
      openTradesMarkedSkip: skipped.changes,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || "Kill switch failed" });
  }
});

const server = app.listen(port, () => {
  console.log(`[${new Date().toISOString()}] dashboard listening on :${port}`);
});

runTickCycle().catch((error) => {
  console.error(`[${new Date().toISOString()}] startup tick failed`, error);
});

const timer = setInterval(() => {
  runTickCycle().catch((error) => {
    console.error(`[${new Date().toISOString()}] scheduled tick failed`, error);
  });
}, tickIntervalMs);

function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] ${signal} received, shutting down`);
  clearInterval(timer);
  server.close(() => {
    try {
      db.sqlite.close();
    } catch {}
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
