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

function round(x, d = 4) {
  return Math.round(x * Math.pow(10, d)) / Math.pow(10, d);
}

function bucket(x) {
  if (x == null) return 'NA';
  if (x < 0.03) return '<3%';
  if (x < 0.05) return '3-5%';
  if (x < 0.10) return '5-10%';
  if (x < 0.20) return '10-20%';
  return '20%+';
}

async function main() {
  const rows = await queryAll();
  const resolved = [];

  for (const p of rows) {
    const props = p.properties || {};
    const result = props.Result?.select?.name;
    if (result !== 'WIN' && result !== 'LOSS') continue;

    const side = props.Side?.select?.name;
    const entryPrice = props.EntryPrice?.number;
    const stake = props.StakeUsd?.number;
    const modelProbYes = props.ModelProb?.number;
    const edgeStored = props.Edge?.number;
    const pnl = props.PnL?.number;
    const city = props.City?.select?.name;
    const q = props.Question?.rich_text?.[0]?.plain_text;

    if (!side || typeof entryPrice !== 'number' || typeof stake !== 'number' || typeof modelProbYes !== 'number' || typeof pnl !== 'number') continue;

    const edgeTrue = side === 'YES'
      ? (modelProbYes - entryPrice)
      : ((1 - modelProbYes) - entryPrice);

    const ev = edgeTrue * stake; // expected $ per trade (approx)

    resolved.push({ city, side, entryPrice, stake, modelProbYes, edgeStored, edgeTrue, pnl, ev, q });
  }

  const byBucket = {};
  let n = 0, sumEdgeTrue = 0, sumPnl = 0, sumEv = 0;
  let edgeMismatch = 0;

  for (const r of resolved) {
    n++;
    sumEdgeTrue += r.edgeTrue;
    sumPnl += r.pnl;
    sumEv += r.ev;
    const b = bucket(r.edgeTrue);
    if (!byBucket[b]) byBucket[b] = { trades: 0, pnl: 0, ev: 0, edgeAvg: 0 };
    byBucket[b].trades += 1;
    byBucket[b].pnl += r.pnl;
    byBucket[b].ev += r.ev;
    byBucket[b].edgeAvg += r.edgeTrue;

    if (typeof r.edgeStored === 'number' && Math.abs(r.edgeStored - r.edgeTrue) > 0.02) edgeMismatch++;
  }

  for (const k of Object.keys(byBucket)) {
    byBucket[k].edgeAvg = round(byBucket[k].edgeAvg / byBucket[k].trades, 4);
    byBucket[k].pnl = round(byBucket[k].pnl, 2);
    byBucket[k].ev = round(byBucket[k].ev, 2);
  }

  // Print a few worst mismatches
  const mismatches = resolved
    .filter(r => typeof r.edgeStored === 'number' && Math.abs(r.edgeStored - r.edgeTrue) > 0.02)
    .sort((a, b) => Math.abs(b.edgeStored - b.edgeTrue) - Math.abs(a.edgeStored - a.edgeTrue))
    .slice(0, 10)
    .map(r => ({ city: r.city, side: r.side, entryPrice: r.entryPrice, modelProbYes: round(r.modelProbYes, 3), edgeStored: round(r.edgeStored, 3), edgeTrue: round(r.edgeTrue, 3), q: (r.q || '').slice(0, 80) }));

  console.log(JSON.stringify({
    resolvedTrades: n,
    totalPnl: round(sumPnl, 2),
    avgEdgeTrue: round(sumEdgeTrue / Math.max(1, n), 4),
    totalApproxEV: round(sumEv, 2),
    edgeMismatchCount: edgeMismatch,
    byEdgeTrueBucket: byBucket,
    topEdgeMismatches: mismatches,
  }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
