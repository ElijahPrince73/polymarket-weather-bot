const fs = require('fs');
const NOTION_KEY = fs.readFileSync(process.env.HOME+'/.config/notion/api_key','utf8').trim();
const NOTION_VERSION='2025-09-03';
const DATA_SOURCE_ID='a2ded902-f906-4f34-ac83-33014bdca7b5';

const CITY_ABBR = { 'London':'LON','Dallas':'DAL','Atlanta':'ATL','New York City':'NYC','Seoul':'SEL' };

async function fetchJson(url, opts={}){
  const res = await fetch(url, opts);
  if(!res.ok){ throw new Error(`${res.status} ${res.statusText} ${url}`); }
  return res.json();
}

function isoDate(d=new Date()) { return d.toISOString().slice(0,10); }

async function main(){
  const today = isoDate();
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
    rows.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while(cursor);

  const perCity = {};
  for(const r of rows){
    const status = r.properties?.Status?.select?.name;
    if(status !== 'PAPER_OPEN') continue;
    const result = r.properties?.Result?.select?.name;
    const resolvedAt = r.properties?.ResolvedAt?.date?.start;
    if(!resolvedAt || resolvedAt.slice(0,10) !== today) continue;

    const city = r.properties?.City?.select?.name || 'Unknown';
    const abbr = CITY_ABBR[city] || city;
    const side = r.properties?.Side?.select?.name || '';
    const price = r.properties?.Price?.number ?? null;
    const stake = r.properties?.StakeUsd?.number ?? null;
    const q = r.properties?.Question?.rich_text?.[0]?.plain_text || '';

    if(price == null || stake == null) continue;

    let pnl = 0;
    if(result === 'WIN') pnl = stake * (1/price - 1);
    else if(result === 'LOSS') pnl = -stake;
    else continue;

    if(!perCity[abbr]) perCity[abbr] = { wins:0, losses:0, pnl:0, trades:0, winList:[], lossList:[] };
    perCity[abbr].trades += 1;
    if(result==='WIN') { perCity[abbr].wins += 1; perCity[abbr].winList.push(`${q} (${side})`); }
    if(result==='LOSS') { perCity[abbr].losses += 1; perCity[abbr].lossList.push(`${q} (${side})`); }
    perCity[abbr].pnl += pnl;
  }

  const lines = [];
  for (const [city, v] of Object.entries(perCity)) {
    const sign = v.pnl >= 0 ? '+' : '';
    lines.push(`${city}: ${v.wins}W/${v.losses}L, PnL ${sign}${v.pnl.toFixed(2)}`);
    if (v.winList.length) lines.push(`  Wins: ${v.winList.join(' | ')}`);
    if (v.lossList.length) lines.push(`  Losses: ${v.lossList.join(' | ')}`);
  }

  if(lines.length === 0){
    console.log('No resolved trades today.');
    return;
  }
  console.log(lines.join('\n'));
}

main().catch(err=>{console.error(err); process.exit(1);});
