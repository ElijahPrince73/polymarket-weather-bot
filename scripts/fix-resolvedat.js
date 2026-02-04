const fs = require('fs');

const NOTION_KEY = fs.readFileSync(process.env.HOME+'/.config/notion/api_key','utf8').trim();
const NOTION_VERSION='2025-09-03';
const DATA_SOURCE_ID='a2ded902-f906-4f34-ac83-33014bdca7b5';

async function fetchJson(url, opts={}){
  const res = await fetch(url, opts);
  if(!res.ok){ throw new Error(`${res.status} ${res.statusText} ${url}`); }
  return res.json();
}

function isoNow(){ return new Date().toISOString(); }

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
    pages.push(...(data.results||[]));
    cursor = data.has_more ? data.next_cursor : null;
  } while(cursor);

  let patched=0;
  let skipped=0;

  for(const p of pages){
    const props = p.properties || {};
    const result = props.Result?.select?.name;
    const resolvedAt = props.ResolvedAt?.date?.start;

    // Only backfill when we already have a terminal Result but no ResolvedAt.
    if(!(result === 'WIN' || result === 'LOSS')) { skipped++; continue; }
    if(resolvedAt) { skipped++; continue; }

    await fetchJson(`https://api.notion.com/v1/pages/${p.id}`,{
      method:'PATCH',
      headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
      body: JSON.stringify({
        properties:{
          ResolvedAt:{ date:{ start: isoNow() } }
        }
      })
    });
    patched++;
  }

  console.log(`fix-resolvedat: patched=${patched}, skipped=${skipped}, total=${pages.length}`);
}

main().catch(err=>{console.error(err); process.exit(1);});
