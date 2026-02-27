import { sqlite } from "../db.js";

function round(x, d = 2) {
  const k = 10 ** d;
  return Math.round(x * k) / k;
}

function edgeBucket(edge) {
  if (edge == null) return "NA";
  if (edge < 0.03) return "<3%";
  if (edge < 0.05) return "3-5%";
  if (edge < 0.1) return "5-10%";
  if (edge < 0.2) return "10-20%";
  return "20%+";
}

export function dailySummary() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = sqlite
    .prepare(
      `SELECT * FROM trades
       WHERE result IN ('WIN','LOSS')
         AND resolved_at IS NOT NULL
         AND substr(resolved_at,1,10)=?`
    )
    .all(today);

  const byCity = {};
  const edgeBuckets = {
    "<3%": { trades: 0, pnl: 0 },
    "3-5%": { trades: 0, pnl: 0 },
    "5-10%": { trades: 0, pnl: 0 },
    "10%+": { trades: 0, pnl: 0 },
  };

  for (const row of rows) {
    const city = row.city || "Unknown";
    const pnl =
      typeof row.pnl === "number"
        ? row.pnl
        : row.result === "WIN"
          ? row.stake_usd * (1 / row.entry_price - 1)
          : -row.stake_usd;
    const bucket = row.edge < 0.03 ? "<3%" : row.edge < 0.05 ? "3-5%" : row.edge < 0.1 ? "5-10%" : "10%+";

    if (!byCity[city]) byCity[city] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    byCity[city].trades += 1;
    byCity[city].pnl += pnl;
    if (row.result === "WIN") byCity[city].wins += 1;
    if (row.result === "LOSS") byCity[city].losses += 1;

    edgeBuckets[bucket].trades += 1;
    edgeBuckets[bucket].pnl += pnl;
  }

  return { date: today, trades: rows.length, byCity, edgeBuckets };
}

export function rollingReport(_db, days = 30) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = sqlite
    .prepare(
      `SELECT * FROM trades
       WHERE result IN ('WIN','LOSS')
         AND resolved_at IS NOT NULL
         AND substr(resolved_at,1,10) >= ?`
    )
    .all(since);

  const byCity = {};
  const byEdgeTrueBucket = {};
  let pnl = 0;
  let stake = 0;
  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    const city = row.city || "Unknown";
    const rowPnl = row.pnl ?? 0;
    const rowStake = row.stake_usd ?? 0;
    const edgeTrue =
      row.side === "YES" ? row.model_prob - row.entry_price : 1 - row.model_prob - row.entry_price;
    const bucket = edgeBucket(edgeTrue);

    pnl += rowPnl;
    stake += rowStake;
    if (row.result === "WIN") wins += 1;
    if (row.result === "LOSS") losses += 1;

    if (!byCity[city]) byCity[city] = { trades: 0, pnl: 0, stake: 0, wins: 0, losses: 0 };
    byCity[city].trades += 1;
    byCity[city].pnl += rowPnl;
    byCity[city].stake += rowStake;
    if (row.result === "WIN") byCity[city].wins += 1;
    if (row.result === "LOSS") byCity[city].losses += 1;

    if (!byEdgeTrueBucket[bucket]) byEdgeTrueBucket[bucket] = { trades: 0, pnl: 0, stake: 0, wins: 0, losses: 0 };
    byEdgeTrueBucket[bucket].trades += 1;
    byEdgeTrueBucket[bucket].pnl += rowPnl;
    byEdgeTrueBucket[bucket].stake += rowStake;
    if (row.result === "WIN") byEdgeTrueBucket[bucket].wins += 1;
    if (row.result === "LOSS") byEdgeTrueBucket[bucket].losses += 1;
  }

  for (const k of Object.keys(byCity)) {
    byCity[k].pnl = round(byCity[k].pnl);
    byCity[k].stake = round(byCity[k].stake);
    byCity[k].roi = byCity[k].stake ? round(byCity[k].pnl / byCity[k].stake, 3) : null;
  }
  for (const k of Object.keys(byEdgeTrueBucket)) {
    byEdgeTrueBucket[k].pnl = round(byEdgeTrueBucket[k].pnl);
    byEdgeTrueBucket[k].stake = round(byEdgeTrueBucket[k].stake);
    byEdgeTrueBucket[k].roi = byEdgeTrueBucket[k].stake
      ? round(byEdgeTrueBucket[k].pnl / byEdgeTrueBucket[k].stake, 3)
      : null;
  }

  return {
    windowDays: days,
    since,
    trades: rows.length,
    wins,
    losses,
    winrate: rows.length ? round(wins / rows.length, 3) : null,
    pnl: round(pnl),
    stake: round(stake),
    roi: stake ? round(pnl / stake, 3) : null,
    byCity,
    byEdgeTrueBucket,
  };
}
