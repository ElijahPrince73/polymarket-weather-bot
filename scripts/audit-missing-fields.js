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

function getText(prop){
  const rt = prop?.rich_text;
  if(Array.isArray(rt) && rt[0]) return rt[0].plain_text;
  return null;
}

async function queryAll(filter){
  let cursor=null;
  const rows=[];
  do{
    const body={page_size:100, filter};
    if(cursor) body.start_cursor=cursor;
    const data=await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`,{
      method:'POST',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    rows.push(...(data.results||[]));
    cursor = data.has_more ? data.next_cursor : null;
  } while(cursor);
  return rows;
}

async function main(){
  const start = process.env.START || '2026-01-31';
  const end = process.env.END || '2026-02-01';

  // Notion doesn't have a direct "between" filter in all contexts; use AND.
  const filter = {
    and: [
      { property: 'EventDate', date: { on_or_after: start } },
      { property: 'EventDate', date: { on_or_before: end } },
    ]
  };

  const rows = await queryAll(filter);
  const out = [];

  for(const p of rows){
    const props = p.properties || {};
    const city = props.City?.select?.name || null;
    const eventDate = props.EventDate?.date?.start || null;
    const status = props.Status?.select?.name || null;
    const result = props.Result?.select?.name || null;

    const missing = [];
    if(!getText(props.Question)) missing.push('Question');
    if(!props.MarketURL?.url) missing.push('MarketURL');
    if(!props.Side?.select?.name && status === 'PAPER_OPEN') missing.push('Side');
    if(props.EntryPrice?.number == null && status === 'PAPER_OPEN') missing.push('EntryPrice');
    if(props.StakeUsd?.number == null && status === 'PAPER_OPEN') missing.push('StakeUsd');

    // if resolved but missing pnl fields
    if((result === 'WIN' || result === 'LOSS')){
      if(props.PnL?.number == null) missing.push('PnL');
      if(props.CumPnL?.number == null) missing.push('CumPnL');
      if(!props.ResolvedAt?.date?.start) missing.push('ResolvedAt');
    }

    if(missing.length){
      out.push({ id: p.id, city, eventDate, status, result, missing });
    }
  }

  out.sort((a,b)=> (a.eventDate||'').localeCompare(b.eventDate||'') || (a.city||'').localeCompare(b.city||''));

  console.log(JSON.stringify({ range: { start, end }, totalRows: rows.length, rowsWithMissing: out.length, problems: out }, null, 2));
}

main().catch(err=>{console.error(err); process.exit(1);});
