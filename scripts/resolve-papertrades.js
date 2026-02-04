const fs = require('fs');
const NOTION_KEY = fs.readFileSync(process.env.HOME+'/.config/notion/api_key','utf8').trim();
const NOTION_VERSION='2025-09-03';
const DATA_SOURCE_ID='a2ded902-f906-4f34-ac83-33014bdca7b5';
const CALIB_PATH = `${process.env.HOME}/clawd/data/calibration.json`;

async function fetchJson(url, opts={}){
  const res = await fetch(url, opts);
  if(!res.ok){ throw new Error(`${res.status} ${res.statusText} ${url}`); }
  return res.json();
}

function extractEventSlug(url){
  if(!url) return null;
  const m = url.match(/polymarket\.com\/event\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function parseResolved(outcomes, prices){
  if(!outcomes || !prices) return null;
  let maxIdx = -1;
  let max = -1;
  for(let i=0;i<prices.length;i++){
    const p = parseFloat(prices[i]);
    if(p>max){ max=p; maxIdx=i; }
  }
  if(max < 0.95) return null; // not resolved
  const outcome = outcomes[maxIdx];
  if(!outcome) return null;
  const val = outcome.toLowerCase()==='yes' ? 1 : 0;
  return { outcome, val, confidence: max };
}

function detectType(q){
  const t = (q||'').toLowerCase();
  if (t.includes('highest temperature')) return 'temp_max';
  if (t.includes('lowest temperature')) return 'temp_min';
  if (t.includes('precipitation') || t.includes('rain')) return 'precip_yesno';
  if (t.includes('snow')) return 'snow_yesno';
  if (t.includes('wind')) return 'wind_yesno';
  return 'other';
}

function loadCalib(){
  try{ if(!fs.existsSync(CALIB_PATH)) return {}; return JSON.parse(fs.readFileSync(CALIB_PATH,'utf8')); } catch { return {}; }
}
function saveCalib(c){
  fs.mkdirSync(`${process.env.HOME}/clawd/data`, { recursive: true });
  fs.writeFileSync(CALIB_PATH, JSON.stringify(c,null,2));
}

async function main(){
  let cursor=null;
  const pages=[];
  do{
    const body={page_size:100};
    if(cursor) body.start_cursor=cursor;
    const data=await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`,{
      method:'POST',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while(cursor);

  const calib = loadCalib();
  for(const p of pages){
    const status = p.properties?.Status?.select?.name;
    const result = p.properties?.Result?.select?.name;
    const RESOLVE_STATUSES = new Set(['PAPER_OPEN','PAPER_STOP','PAPER_SWITCHED']);
    if(!RESOLVE_STATUSES.has(status)) continue;
    if(result && result !== 'PENDING') continue;

    const q = p.properties?.Question?.rich_text?.[0]?.plain_text;
    const side = p.properties?.Side?.select?.name;
    const url = p.properties?.MarketURL?.url;
    const entryPrice = p.properties?.EntryPrice?.number;
    const stake = p.properties?.StakeUsd?.number;
    const slug = extractEventSlug(url);
    if(!slug || !q || !side) continue;

    const event = await fetchJson(`https://gamma-api.polymarket.com/events/slug/${slug}`);
    if(!event?.markets) continue;
    const market = event.markets.find(m => (m.question||'').trim() === q.trim()) || event.markets[0];
    if(!market) continue;

    const closed = market.closed || event.closed;
    if(!closed) continue;

    const outcomes = JSON.parse(market.outcomes || '[]');
    const prices = JSON.parse(market.outcomePrices || '[]');
    const resolved = parseResolved(outcomes, prices);
    if(!resolved) continue;

    const win = (resolved.val===1 && side==='YES') || (resolved.val===0 && side==='NO');

    // update calibration (EWMA of error)
    const city = p.properties?.City?.select?.name || 'Unknown';
    const modelProb = p.properties?.ModelProb?.number;
    const type = detectType(q);
    if(modelProb != null){
      const key = `${city}:${type}`;
      const prev = calib[key]?.bias ?? 0;
      const err = resolved.val - modelProb;
      const bias = prev * 0.9 + err * 0.1;
      calib[key] = { bias, updatedAt: new Date().toISOString() };
    }

    const pnl = (entryPrice != null && stake != null)
      ? (win ? (stake * (1/entryPrice - 1)) : -stake)
      : null;

    await fetchJson(`https://api.notion.com/v1/pages/${p.id}`,{
      method:'PATCH',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify({
        properties:{
          Result:{ select:{ name: win ? 'WIN' : 'LOSS' } },
          ResolvedAt:{ date:{ start: new Date().toISOString() } },
          ...(pnl == null ? {} : { PnL: { number: pnl } })
        }
      })
    });
  }
  saveCalib(calib);
  console.log('resolution check complete');
}

main().catch(err=>{console.error(err); process.exit(1);});
