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

async function ensureRowProperty(){
  const ds = await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, {
    headers: { Authorization: `Bearer ${NOTION_KEY}`, 'Notion-Version': NOTION_VERSION }
  });
  if(ds.properties?.Row) return;
  await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: { Row: { number: { format: 'number' } } } })
  });
}

async function queryAll(){
  let cursor=null;
  const rows=[];
  do{
    const body={page_size:100};
    if(cursor) body.start_cursor = cursor;
    const data = await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method:'POST',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    rows.push(...(data.results||[]));
    cursor = data.has_more ? data.next_cursor : null;
  } while(cursor);
  return rows;
}

function safeStr(x){ return (x==null?'':String(x)); }

async function main(){
  const start = process.env.START || null; // optional YYYY-MM-DD filter (EventDate on_or_after)

  await ensureRowProperty();
  const pages = await queryAll();

  let items = pages.map(p => {
    const props = p.properties || {};
    return {
      id: p.id,
      eventDate: props.EventDate?.date?.start || null,
      city: props.City?.select?.name || null,
      name: props.Name?.title?.[0]?.plain_text || null,
    };
  });

  if(start){
    items = items.filter(i => i.eventDate && i.eventDate.slice(0,10) >= start);
  }

  // Sort: EventDate asc, City asc, Name asc, id asc
  items.sort((a,b)=>
    safeStr(a.eventDate).localeCompare(safeStr(b.eventDate)) ||
    safeStr(a.city).localeCompare(safeStr(b.city)) ||
    safeStr(a.name).localeCompare(safeStr(b.name)) ||
    safeStr(a.id).localeCompare(safeStr(b.id))
  );

  let patched=0;
  for(let idx=0; idx<items.length; idx++){
    const rowNum = idx + 1;
    const it = items[idx];
    await fetchJson(`https://api.notion.com/v1/pages/${it.id}`, {
      method:'PATCH',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify({ properties: { Row: { number: rowNum } } })
    });
    patched++;
  }

  console.log(`renumber-rows: start=${start||'ALL'} patched=${patched}`);
}

main().catch(err=>{console.error(err); process.exit(1);});
