import db, { sqlite } from "../db.js";
import { detectMarketType, fetchJson } from "../utils.js";

function extractEventSlug(url) {
  const m = String(url || "").match(/polymarket\.com\/event\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function parseJsonArray(s) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}

function parseResolved(outcomes, prices) {
  if (!outcomes.length || !prices.length) return null;
  let max = -1;
  let maxIdx = -1;
  for (let i = 0; i < prices.length; i += 1) {
    const p = Number.parseFloat(prices[i]);
    if (p > max) {
      max = p;
      maxIdx = i;
    }
  }
  if (max < 0.95 || maxIdx < 0) return null;
  const outcome = outcomes[maxIdx];
  if (!outcome) return null;
  const val = String(outcome).toLowerCase() === "yes" ? 1 : 0;
  return { outcome, val, confidence: max };
}

export async function runResolver(dbApi = db) {
  const now = new Date().toISOString();
  const rows = sqlite
    .prepare(
      `SELECT * FROM trades
       WHERE status IN ('OPEN','STOP','SWITCHED')
         AND (result IS NULL OR result='PENDING')`
    )
    .all();

  let resolved = 0;
  for (const row of rows) {
    const slug = extractEventSlug(row.market_url);
    if (!slug || !row.question || !row.side) continue;
    const event = await fetchJson(`https://gamma-api.polymarket.com/events/slug/${slug}`);
    const market =
      event?.markets?.find((m) => String(m.question || "").trim() === String(row.question).trim()) ??
      event?.markets?.[0];
    if (!market) continue;
    if (!(market.closed || event.closed)) continue;

    const outcomes = parseJsonArray(market.outcomes);
    const prices = parseJsonArray(market.outcomePrices);
    const final = parseResolved(outcomes, prices);
    if (!final) continue;

    const win = (final.val === 1 && row.side === "YES") || (final.val === 0 && row.side === "NO");
    const pnl =
      row.entry_price != null && row.stake_usd != null
        ? win
          ? row.stake_usd * (1 / row.entry_price - 1)
          : -row.stake_usd
        : null;

    dbApi.updateTrade(row.id, {
      status: "RESOLVED",
      result: win ? "WIN" : "LOSS",
      pnl,
      resolved_at: now,
    });
    resolved += 1;

    if (row.model_prob != null) {
      const type = detectMarketType(row.question) || "other";
      const prev = dbApi.getCalibration(row.city || "Unknown", type)?.bias ?? 0;
      const err = final.val - row.model_prob;
      const bias = prev * 0.9 + err * 0.1;
      dbApi.upsertCalibration(row.city || "Unknown", type, bias, now);
    }
  }
  return { resolved };
}
