const fs = require('fs');

const NOTION_KEY = fs.readFileSync(process.env.HOME+'/.config/notion/api_key','utf8').trim();
const NOTION_VERSION='2025-09-03';
const DATA_SOURCE_ID='a2ded902-f906-4f34-ac83-33014bdca7b5';

async function fetchJson(url, opts={}){
  const res = await fetch(url, opts);
  if(!res.ok){
    const txt = await res.text().catch(()=>null);
    throw new Error(`${res.status} ${res.statusText} ${url}${txt?` :: ${txt}`:''}`);
  }
  return res.json();
}

function isoDate(d){ return (d||'').slice(0,10); }

function calcPnl(result, stake, entryPrice){
  if(stake == null || entryPrice == null) return null;
  if(result === 'WIN') return stake * (1/entryPrice - 1);
  if(result === 'LOSS') return -stake;
  return null;
}

async function main(){
  const since = process.env.SINCE || '2026-01-30';

  let cursor=null;
  const rows=[];
  do{
    const body={page_size:100};
    if(cursor) body.start_cursor=cursor;
    const data=await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`,{
      method:'POST',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    rows.push(...(data.results||[]));
    cursor = data.has_more ? data.next_cursor : null;
  } while(cursor);

  const resolved = rows
    .map(p => {
      const props = p.properties || {};
      const result = props.Result?.select?.name;
      const resolvedAt = props.ResolvedAt?.date?.start;
      const entryPrice = props.EntryPrice?.number;
      const stake = props.StakeUsd?.number;
      const eventDate = props.EventDate?.date?.start;
      return { id: p.id, result, resolvedAt, entryPrice, stake, eventDate };
    })
    .filter(r => (r.result === 'WIN' || r.result === 'LOSS'))
    .filter(r => r.resolvedAt && isoDate(r.resolvedAt) >= since);

  resolved.sort((a,b)=> (a.resolvedAt < b.resolvedAt ? -1 : a.resolvedAt > b.resolvedAt ? 1 : (a.id < b.id ? -1 : 1)));

  let cum = 0;
  let patched = 0;
  let skipped = 0;

  for(const r of resolved){
    const pnl = calcPnl(r.result, r.stake, r.entryPrice);
    if(pnl == null){ skipped++; continue; }
    cum += pnl;
    await fetchJson(`https://api.notion.com/v1/pages/${r.id}`,{
      method:'PATCH',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify({
        properties:{
          PnL: { number: pnl },
          CumPnL: { number: cum }
        }
      })
    });
    patched++;
  }

  console.log(`recompute-cumpnl: since=${since} patched=${patched} skipped=${skipped} totalResolved=${resolved.length} finalCumPnL=${cum.toFixed(2)}`);
}

main().catch(err=>{console.error(err); process.exit(1);});
