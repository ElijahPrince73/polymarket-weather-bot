const fs = require('fs');

const NOTION_KEY = fs.readFileSync(process.env.HOME + '/.config/notion/api_key', 'utf8').trim();
const NOTION_VERSION = '2025-09-03';
const DATA_SOURCE_ID = 'a2ded902-f906-4f34-ac83-33014bdca7b5';

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const txt = await res.text().catch(() => null);
    throw new Error(`${res.status} ${res.statusText} ${url}${txt ? ` :: ${txt}` : ''}`);
  }
  return res.json();
}

async function queryAll() {
  let cursor = null;
  const rows = [];
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    rows.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return rows;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
function round(x, d = 2) { return Math.round(x * Math.pow(10, d)) / Math.pow(10, d); }

function edgeBucket(edgeTrue) {
  if (edgeTrue == null) return 'NA';
  if (edgeTrue < 0.03) return '<3%';
  if (edgeTrue < 0.05) return '3-5%';
  if (edgeTrue < 0.10) return '5-10%';
  if (edgeTrue < 0.20) return '10-20%';
  return '20%+';
}

async function main() {
  const days = parseInt(process.env.DAYS || '30', 10);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const sinceIso = isoDate(since);

  const rows = await queryAll();

  const byCity = {};
  const byBucket = {};
  let pnl = 0, trades = 0, wins = 0, losses = 0, stakeSum = 0;

  for (const p of rows) {
    const props = p.properties || {};
    const result = props.Result?.select?.name;
    if (result !== 'WIN' && result !== 'LOSS') continue;
    const resolvedAt = props.ResolvedAt?.date?.start;
    if (!resolvedAt || resolvedAt.slice(0, 10) < sinceIso) continue;

    const city = props.City?.select?.name || 'Unknown';
    const side = props.Side?.select?.name;
    const entryPrice = props.EntryPrice?.number;
    const stake = props.StakeUsd?.number;
    const modelProbYes = props.ModelProb?.number;
    const pnlRow = props.PnL?.number;

    if (!side || typeof entryPrice !== 'number' || typeof stake !== 'number' || typeof modelProbYes !== 'number' || typeof pnlRow !== 'number') continue;

    const edgeTrue = side === 'YES'
      ? (modelProbYes - entryPrice)
      : ((1 - modelProbYes) - entryPrice);

    const b = edgeBucket(edgeTrue);

    trades++;
    pnl += pnlRow;
    stakeSum += stake;
    if (result === 'WIN') wins++; else losses++;

    if (!byCity[city]) byCity[city] = { trades: 0, pnl: 0, stake: 0, wins: 0, losses: 0 };
    byCity[city].trades++;
    byCity[city].pnl += pnlRow;
    byCity[city].stake += stake;
    if (result === 'WIN') byCity[city].wins++; else byCity[city].losses++;

    if (!byBucket[b]) byBucket[b] = { trades: 0, pnl: 0, stake: 0, wins: 0, losses: 0 };
    byBucket[b].trades++;
    byBucket[b].pnl += pnlRow;
    byBucket[b].stake += stake;
    if (result === 'WIN') byBucket[b].wins++; else byBucket[b].losses++;
  }

  for (const k of Object.keys(byCity)) {
    byCity[k].pnl = round(byCity[k].pnl, 2);
    byCity[k].stake = round(byCity[k].stake, 2);
    byCity[k].roi = byCity[k].stake ? round(byCity[k].pnl / byCity[k].stake, 3) : null;
  }

  for (const k of Object.keys(byBucket)) {
    byBucket[k].pnl = round(byBucket[k].pnl, 2);
    byBucket[k].stake = round(byBucket[k].stake, 2);
    byBucket[k].roi = byBucket[k].stake ? round(byBucket[k].pnl / byBucket[k].stake, 3) : null;
  }

  console.log(JSON.stringify({
    windowDays: days,
    since: sinceIso,
    trades,
    wins,
    losses,
    winrate: trades ? round(wins / trades, 3) : null,
    pnl: round(pnl, 2),
    stake: round(stakeSum, 2),
    roi: stakeSum ? round(pnl / stakeSum, 3) : null,
    byCity,
    byEdgeTrueBucket: byBucket
  }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
