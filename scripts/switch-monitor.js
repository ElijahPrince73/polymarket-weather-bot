const fs = require('fs');
const NOTION_KEY = fs.readFileSync(process.env.HOME+'/.config/notion/api_key','utf8').trim();
const NOTION_VERSION='2025-09-03';
const DATA_SOURCE_ID='a2ded902-f906-4f34-ac83-33014bdca7b5';

async function fetchJson(url, opts={}){
  const res = await fetch(url, opts);
  if(!res.ok){ throw new Error(`${res.status} ${res.statusText} ${url}`); }
  return res.json();
}

function extractEventSlug(url){
  const m = (url||'').match(/polymarket\.com\/event\/([^/?#]+)/i);
  return m ? m[1] : null;
}

async function clobPrice(tokenId){
  const data = await fetchJson(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`);
  return parseFloat(data.price);
}

(async()=>{
  let cursor=null; const rows=[];
  do{
    const body={page_size:100}; if(cursor) body.start_cursor=cursor;
    const data=await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`,{
      method:'POST', headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    rows.push(...data.results); cursor=data.has_more?data.next_cursor:null;
  } while(cursor);

  const open = rows.filter(r=> r.properties?.Status?.select?.name==='PAPER_OPEN');

  for(const r of open){
    const q = r.properties?.Question?.rich_text?.[0]?.plain_text || '';
    const side = r.properties?.Side?.select?.name;
    const city = r.properties?.City?.select?.name;
    const url = r.properties?.MarketURL?.url;
    const modelProb = r.properties?.ModelProb?.number;
    if(!q || !side || !url || modelProb==null) continue;

    const slug = extractEventSlug(url);
    if(!slug) continue;

    const event = await fetchJson(`https://gamma-api.polymarket.com/events/slug/${slug}`);
    const market = event.markets.find(m => (m.question||'').trim()===q.trim()) || event.markets[0];
    if(!market) continue;

    const outcomes = JSON.parse(market.outcomes||'[]');
    const tokenIds = JSON.parse(market.clobTokenIds||'[]');
    const yesIdx = outcomes.findIndex(o=>o.toLowerCase()==='yes');
    const noIdx = outcomes.findIndex(o=>o.toLowerCase()==='no');

    let yesPrice = parseFloat(JSON.parse(market.outcomePrices||'[]')[yesIdx]);
    let noPrice = parseFloat(JSON.parse(market.outcomePrices||'[]')[noIdx]);
    if(tokenIds.length){
      try { yesPrice = await clobPrice(tokenIds[yesIdx]); } catch {}
      try { noPrice = await clobPrice(tokenIds[noIdx]); } catch {}
    }

    const edgeYes = modelProb - yesPrice;
    const edgeNo = (1 - modelProb) - noPrice;
    const edgeExisting = side==='YES' ? edgeYes : edgeNo;
    const edgeOpp = side==='YES' ? edgeNo : edgeYes;
    const oppSide = side==='YES' ? 'NO' : 'YES';
    const oppPrice = side==='YES' ? noPrice : yesPrice;

    // Stop-loss: if price moves 20% against entry
    const entry = r.properties?.EntryPrice?.number;
    if (entry != null) {
      const current = side==='YES' ? yesPrice : noPrice;
      if (current <= entry * 0.8) {
        await fetchJson(`https://api.notion.com/v1/pages/${r.id}`,{
          method:'PATCH', headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
          body: JSON.stringify({properties:{Status:{select:{name:'PAPER_STOP'}}, Notes:{rich_text:[{text:{content:`Stop-loss hit at ${current} (entry ${entry})`}}]}}})
        });
        continue;
      }
    }

    if (edgeExisting < -0.05 && edgeOpp >= 0.05) {
      // mark existing as switched
      await fetchJson(`https://api.notion.com/v1/pages/${r.id}`,{
        method:'PATCH', headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
        body: JSON.stringify({properties:{Status:{select:{name:'PAPER_SWITCHED'}}, Notes:{rich_text:[{text:{content:`Switched to ${oppSide} at ${new Date().toISOString()}`}}]}}})
      });
      // create new row for switched position
      const title = `${city} | ${oppSide} | ${(r.properties?.EventDate?.date?.start||'')}`;
      await fetchJson('https://api.notion.com/v1/pages',{
        method:'POST', headers:{Authorization:`Bearer ${NOTION_KEY}`,'Notion-Version':NOTION_VERSION,'Content-Type':'application/json'},
        body: JSON.stringify({
          parent:{database_id:'e1756234-ea9a-40e1-93d7-8493dadc2e00'},
          properties:{
            Name:{title:[{text:{content:title}}]},
            City:{select:{name:city}},
            Question:{rich_text:[{text:{content:q.slice(0,2000)}}]},
            MarketURL:{url},
            EventDate:{date:{start:r.properties?.EventDate?.date?.start||null}},
            Status:{select:{name:'PAPER_OPEN'}},
            Side:{select:{name:oppSide}},
            EntryPrice:{number:oppPrice},
            ModelProb:{number:modelProb},
            Edge:{number:edgeOpp},
            SizePct:{number:r.properties?.SizePct?.number||0.01},
            StakeUsd:{number:r.properties?.StakeUsd?.number||1},
            Station:{rich_text:[{text:{content:r.properties?.Station?.rich_text?.[0]?.plain_text||''}}]},
            Notes:{rich_text:[{text:{content:`Switch from ${side}`}}]}
          }
        })
      });
    }
  }
  console.log('switch monitor complete');
})().catch(e=>{console.error(e); process.exit(1);});
