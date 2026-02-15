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

async function ensureStatusOption(){
  const ds = await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, {
    headers: { Authorization: `Bearer ${NOTION_KEY}`, 'Notion-Version': NOTION_VERSION }
  });
  const opts = ds.properties?.Status?.select?.options || [];
  if (opts.find(o => o.name === 'PAPER_RESOLVED')) return;
  await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${NOTION_KEY}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: {
        Status: { select: { options: [...opts, { name: 'PAPER_RESOLVED' }] } }
      }
    })
  });
}

async function queryAll(){
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
  return rows;
}

async function main(){
  await ensureStatusOption();
  const rows = await queryAll();

  const toPatch = [];
  for(const p of rows){
    const props=p.properties||{};
    const status=props.Status?.select?.name;
    const result=props.Result?.select?.name;
    if(status !== 'PAPER_OPEN') continue;
    if(result !== 'WIN' && result !== 'LOSS') continue;
    toPatch.push(p.id);
  }

  let patched=0;
  for(const id of toPatch){
    await fetchJson(`https://api.notion.com/v1/pages/${id}`,{
      method:'PATCH',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify({ properties: { Status: { select: { name: 'PAPER_RESOLVED' } } } })
    });
    patched++;
  }

  console.log(`backfill-status-resolved: found=${toPatch.length} patched=${patched}`);
}

main().catch(err=>{console.error(err); process.exit(1);});
