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

async function archivePage(id){
  await fetchJson(`https://api.notion.com/v1/pages/${id}`,{
    method:'PATCH',
    headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
    body: JSON.stringify({ archived: true })
  });
}

async function main(){
  const targetDate = process.env.DATE || '2026-02-15';
  const rows = await queryAll();

  const london = rows.filter(p => p.properties?.City?.select?.name === 'London');

  // Only clean up duplicate PAPER_SKIP rows with the placeholder question.
  const skips = london.filter(p => {
    const status = p.properties?.Status?.select?.name;
    const ed = p.properties?.EventDate?.date?.start;
    const q = p.properties?.Question?.rich_text?.[0]?.plain_text;
    return status === 'PAPER_SKIP' && ed === targetDate && q === 'No qualifying market';
  });

  // Keep newest, archive all others.
  skips.sort((a,b)=> (a.created_time < b.created_time ? 1 : -1));
  const keep = skips[0];
  const toArchive = skips.slice(1);

  for(const p of toArchive){
    await archivePage(p.id);
  }

  console.log(JSON.stringify({
    city: 'London',
    date: targetDate,
    found: skips.length,
    kept: keep ? keep.id : null,
    archived: toArchive.length
  }, null, 2));
}

main().catch(err=>{console.error(err); process.exit(1);});
