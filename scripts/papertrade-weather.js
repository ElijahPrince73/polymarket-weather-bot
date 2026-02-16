import fs from 'fs';

const NOTION_KEY = fs.readFileSync(`${process.env.HOME}/.config/notion/api_key`, 'utf8').trim();
const NOTION_VERSION = '2025-09-03';
const DATA_SOURCE_ID = 'a2ded902-f906-4f34-ac83-33014bdca7b5';

const CITIES = [
  { name: 'London', tz: 'Europe/London', aliases: ['London'], station: { code: 'EGLC', lat: 51.505, lon: 0.055 } },
  { name: 'Dallas', tz: 'America/Chicago', aliases: ['Dallas','DFW'], station: { code: 'KDAL', lat: 32.847, lon: -96.852 } },
  { name: 'Atlanta', tz: 'America/New_York', aliases: ['Atlanta','ATL'], station: { code: 'KATL', lat: 33.6407, lon: -84.4277 } },
  { name: 'New York City', tz: 'America/New_York', aliases: ['New York City','NYC','New York'], station: { code: 'KJFK', lat: 40.6413, lon: -73.7781 } },
  { name: 'Seoul', tz: 'Asia/Seoul', aliases: ['Seoul'], station: { code: 'RKSI', lat: 37.4602, lon: 126.4407 } },
];

const SEARCH_TERMS = ['temperature', 'rain', 'precipitation', 'snow', 'wind'];

// --- Trading config ---
const BASE_BANKROLL = 100;

// Hard filters (avoid low-quality trades)
const MIN_EDGE = 0.03;              // require at least +3% model edge
const MIN_PRICE = 0.15;             // tighter market-probability band (YES price)
const MAX_PRICE = 0.85;
const MIN_ABS_MODEL_DIFF = 0.08;    // require |modelProbYes - marketProbYes| >= 8%
const MIN_HOURS_TO_CLOSE = 3;       // avoid last-minute markets

// Risk management
const MAX_DAILY_EXPOSURE_PCT = 0.05; // cap total open stake for today's date
const MAX_CITY_EXPOSURE_PCT = 0.02;  // cap open stake per city/date
const STOP_DAILY_DD_PCT = 0.05;      // if today's realized PnL <= -5% bankroll, stop opening new trades


function fmtDateInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function monthNumber(name) {
  const m = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const i = m.indexOf(name.toLowerCase());
  return i >= 0 ? i + 1 : null;
}

function parseDateFromQuestion(q, tz) {
  // Handles: "January 28" or "Jan 28"
  const match = q.match(/(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})/i);
  if (!match) return null;
  const monthStr = match[1];
  const day = parseInt(match[2], 10);
  const monthMap = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };
  const monKey = monthStr.slice(0,3).toLowerCase();
  const month = monthMap[monKey] || monthNumber(monthStr);
  if (!month) return null;
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date());
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function normalCdf(x) {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

function probTempEquals(forecast, threshold, sigma=1.5) {
  const z1 = ((threshold - 0.5) - forecast) / sigma;
  const z2 = ((threshold + 0.5) - forecast) / sigma;
  return Math.max(0, Math.min(1, normalCdf(z2) - normalCdf(z1)));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function fetchJson(url, opts={}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.json();
}

function loadCalibration(){
  try {
    const p = `${process.env.HOME}/clawd/data/calibration.json`;
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p,'utf8'));
  } catch { return {}; }
}

function applyCalibration(city, type, prob, calib){
  const key = `${city}:${type}`;
  const bias = calib[key]?.bias ?? 0;
  const adj = Math.max(0, Math.min(1, prob + bias));
  return adj;
}

async function ensureNotionSchema() {
  const ds = await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, {
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
    }
  });
  const props = ds.properties || {};
  const needed = {
    City: { select: { options: [] } },
    Station: { rich_text: {} },
    Question: { rich_text: {} },
    MarketURL: { url: {} },
    EventDate: { date: {} },
    Side: { select: { options: [{name:'YES'},{name:'NO'}] } },
    EntryPrice: { number: { format: 'number' } },
    ModelProb: { number: { format: 'number' } },
    Edge: { number: { format: 'number' } },
    SizePct: { number: { format: 'percent' } },
    StakeUsd: { number: { format: 'number' } },
    Status: { select: { options: [{name:'PAPER_OPEN'},{name:'PAPER_SKIP'},{name:'PAPER_SWITCHED'},{name:'PAPER_STOP'},{name:'PAPER_RESOLVED'}] } },
    Notes: { rich_text: {} },
    Row: { number: { format: 'number' } },
  };
  const toAdd = {};
  for (const [k,v] of Object.entries(needed)) {
    if (!props[k]) toAdd[k] = v;
  }
  const needsStatusOption = props.Status && props.Status.select && Array.isArray(props.Status.select.options)
    ? !props.Status.select.options.find(o => o.name === 'PAPER_SWITCHED')
    : false;

  const patchProps = { ...toAdd };
  if (needsStatusOption) {
    patchProps.Status = { select: { options: [...props.Status.select.options, { name: 'PAPER_SWITCHED' }] } };
  }

  if (Object.keys(patchProps).length === 0) return;
  await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: patchProps })
  });
}

async function geocode(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
  const data = await fetchJson(url);
  if (!data.results || !data.results[0]) throw new Error(`No geocode for ${city}`);
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, tz: r.timezone };
}

async function forecastDaily(lat, lon, tz) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&timezone=${encodeURIComponent(tz)}`;
  return await fetchJson(url);
}

async function forecastHourly(lat, lon, tz) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,wind_speed_10m&timezone=${encodeURIComponent(tz)}`;
  return await fetchJson(url);
}

function pickDailyForDate(daily, dateStr) {
  const idx = daily.time.indexOf(dateStr);
  if (idx < 0) return null;
  return {
    date: dateStr,
    tmax: daily.temperature_2m_max[idx],
    tmin: daily.temperature_2m_min[idx],
    precip: daily.precipitation_sum[idx],
    precipProb: daily.precipitation_probability_max[idx],
    windMax: daily.wind_speed_10m_max[idx],
  };
}

function pickHourlyForDate(hourly, dateStr) {
  const temps = [];
  const winds = [];
  const precs = [];
  for (let i = 0; i < hourly.time.length; i++) {
    if (hourly.time[i].startsWith(dateStr)) {
      temps.push(hourly.temperature_2m[i]);
      winds.push(hourly.wind_speed_10m[i]);
      precs.push(hourly.precipitation[i]);
    }
  }
  if (!temps.length) return null;
  return {
    tmax: Math.max(...temps),
    tmin: Math.min(...temps),
    windMax: Math.max(...winds),
    precipSum: precs.reduce((a,b)=>a+b,0)
  };
}

async function searchMarkets(aliases) {
  const results = [];
  for (const alias of aliases) {
    for (const term of SEARCH_TERMS) {
      const q = `${alias} ${term}`;
      const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}`;
      const data = await fetchJson(url);
      if (data.events) results.push(...data.events);
    }
  }
  // de-duplicate by id
  const map = new Map();
  for (const e of results) map.set(e.id, e);
  return Array.from(map.values());
}

async function clobPrice(tokenId) {
  const url = `https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`;
  const data = await fetchJson(url);
  return parseFloat(data.price);
}

function fToC(f){ return (f - 32) * 5/9; }

function parseThresholdC(question) {
  let m = question.match(/(-?\d+)\s*°?C/i);
  if (m) return { valueC: parseFloat(m[1]), unit: 'C' };
  m = question.match(/(-?\d+)\s*°?F/i);
  if (m) return { valueC: fToC(parseFloat(m[1])), unit: 'F' };
  return null;
}

function parseRangeC(question){
  let m = question.match(/(-?\d+)\s*[-–]\s*(-?\d+)\s*°?C/i);
  if (m) return { lowC: parseFloat(m[1]), highC: parseFloat(m[2]), unit:'C' };
  m = question.match(/(-?\d+)\s*[-–]\s*(-?\d+)\s*°?F/i);
  if (m) return { lowC: fToC(parseFloat(m[1])), highC: fToC(parseFloat(m[2])), unit:'F' };
  return null;
}

function parseInequalityC(question){
  let m = question.match(/(-?\d+)\s*°?C\s*(or\s+below|or\s+lower|or\s+less)/i);
  if (m) return { valueC: parseFloat(m[1]), op:'le' };
  m = question.match(/(-?\d+)\s*°?C\s*(or\s+higher|or\s+above|or\s+more)/i);
  if (m) return { valueC: parseFloat(m[1]), op:'ge' };
  m = question.match(/(-?\d+)\s*°?F\s*(or\s+below|or\s+lower|or\s+less)/i);
  if (m) return { valueC: fToC(parseFloat(m[1])), op:'le' };
  m = question.match(/(-?\d+)\s*°?F\s*(or\s+higher|or\s+above|or\s+more)/i);
  if (m) return { valueC: fToC(parseFloat(m[1])), op:'ge' };
  return null;
}

function detectMarketType(question) {
  const q = question.toLowerCase();
  if (q.includes('highest temperature')) return 'temp_max';
  if (q.includes('lowest temperature')) return 'temp_min';
  if (q.includes('rain') || q.includes('precipitation')) return 'precip_yesno';
  if (q.includes('snow')) return 'snow_yesno';
  if (q.includes('wind')) return 'wind_yesno';
  return null;
}

// Temperature market questions can be exact values, ranges, or inequalities.
// We keep logic permissive here and rely on the parsing functions below.
function isTemperatureQuestion(question){
  const q = (question||'').toLowerCase();
  return q.includes('highest temperature') || q.includes('lowest temperature');
}

async function main() {
  await ensureNotionSchema();

  const logs = [];

  // Pull existing rows once to support bankroll + exposure caps.
  let cursor = null;
  const allRows = [];
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await fetchJson(`https://api.notion.com/v1/data_sources/${DATA_SOURCE_ID}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    allRows.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  const bankrollFromNotion = allRows.reduce((acc, r) => {
    const result = r.properties?.Result?.select?.name;
    const pnl = r.properties?.PnL?.number;
    if ((result === 'WIN' || result === 'LOSS') && typeof pnl === 'number') return acc + pnl;
    return acc;
  }, 0);

  const bankroll = BASE_BANKROLL + bankrollFromNotion;

  // Today's realized PnL (stop trading if we hit daily drawdown)
  const todayIso = new Date().toISOString().slice(0, 10);
  const todaysRealizedPnl = allRows.reduce((acc, r) => {
    const result = r.properties?.Result?.select?.name;
    const resolvedAt = r.properties?.ResolvedAt?.date?.start;
    const pnl = r.properties?.PnL?.number;
    if ((result === 'WIN' || result === 'LOSS') && resolvedAt && resolvedAt.slice(0, 10) === todayIso && typeof pnl === 'number') {
      return acc + pnl;
    }
    return acc;
  }, 0);

  const stopForDay = todaysRealizedPnl <= -STOP_DAILY_DD_PCT * bankroll;

  // Prevent duplicates: treat ANY existing (non-skip) row for a city/date as already traded.
  const existingByCityDate = new Set();

  // preload open trades by city/date + current exposures
  const openByCityDate = new Set();
  const openStakeByCityDate = new Map();
  const openStakeToday = new Map(); // key: YYYY-MM-DD, value: total stake

  for (const p of allRows) {
    const status = p.properties?.Status?.select?.name;
    const cityName = p.properties?.City?.select?.name;
    const date = p.properties?.EventDate?.date?.start;
    const stake = p.properties?.StakeUsd?.number ?? 0;
    if (!cityName || !date) continue;

    const key = `${cityName}|${date}`;

    // anything except PAPER_SKIP counts as "already traded" for that city/date
    if (status && status !== 'PAPER_SKIP') existingByCityDate.add(key);

    if (status !== 'PAPER_OPEN') continue;
    openByCityDate.add(key);
    openStakeByCityDate.set(key, (openStakeByCityDate.get(key) || 0) + stake);
    openStakeToday.set(date, (openStakeToday.get(date) || 0) + stake);
  }

  for (const city of CITIES) {
    const localDate = fmtDateInTz(city.tz);
    const { lat, lon, tz } = city.station ? { ...city.station, tz: city.tz } : await geocode(city.name);
    const forecast = await forecastDaily(lat, lon, tz);
    const hourly = await forecastHourly(lat, lon, tz);
    const day = pickDailyForDate(forecast.daily, localDate);
    const dayH = pickHourlyForDate(hourly.hourly, localDate);
    if (!day && !dayH) continue;
    const dayUse = {
      tmax: dayH?.tmax ?? day?.tmax,
      tmin: dayH?.tmin ?? day?.tmin,
      windMax: dayH?.windMax ?? day?.windMax,
      precip: dayH?.precipSum ?? day?.precip,
      precipProb: day?.precipProb ?? null
    };

    const bestByDate = new Map();
    const events = await searchMarkets(city.aliases || [city.name]);
    for (const event of events) {
      if (event.closed) continue;
      if (!event.markets) continue;
      const eventDate = event.endDate ? event.endDate.slice(0,10) : null;
      for (const mkt of event.markets) {
        if (mkt.closed || !mkt.active) continue;
        const q = mkt.question || '';
        const qLower = q.toLowerCase();
        const aliasMatch = (city.aliases || [city.name]).some(a => qLower.includes(a.toLowerCase()));
        if (!aliasMatch) continue;
        const dateStr = parseDateFromQuestion(q, city.tz) || eventDate;
        if (dateStr && dateStr < localDate) continue; // skip past
        const type = detectMarketType(q);
        if (!type) continue;

        // User requirement: only trade temperature markets (no precip/wind/etc)
        if (!isTemperatureQuestion(q)) continue;
        if (type !== 'temp_max' && type !== 'temp_min') continue;

        let modelProb = null;
        let notes = '';

        if (type === 'temp_max') {
          const range = parseRangeC(q);
          const ineq = parseInequalityC(q);
          if (range) {
            const sigma = 1.5;
            const z1 = (range.lowC - dayUse.tmax) / sigma;
            const z2 = (range.highC - dayUse.tmax) / sigma;
            modelProb = Math.max(0, Math.min(1, normalCdf(z2) - normalCdf(z1)));
          } else if (ineq) {
            const sigma = 1.5;
            const z = (ineq.valueC - dayUse.tmax) / sigma;
            modelProb = ineq.op === 'le' ? normalCdf(z) : (1 - normalCdf(z));
          } else {
            const thr = parseThresholdC(q);
            if (!thr) continue;
            modelProb = probTempEquals(dayUse.tmax, thr.valueC);
          }
          notes = `Forecast tmax=${dayUse.tmax}C (hourly)`;
        } else if (type === 'temp_min') {
          const range = parseRangeC(q);
          const ineq = parseInequalityC(q);
          if (range) {
            const sigma = 1.5;
            const z1 = (range.lowC - dayUse.tmin) / sigma;
            const z2 = (range.highC - dayUse.tmin) / sigma;
            modelProb = Math.max(0, Math.min(1, normalCdf(z2) - normalCdf(z1)));
          } else if (ineq) {
            const sigma = 1.5;
            const z = (ineq.valueC - dayUse.tmin) / sigma;
            modelProb = ineq.op === 'le' ? normalCdf(z) : (1 - normalCdf(z));
          } else {
            const thr = parseThresholdC(q);
            if (!thr) continue;
            modelProb = probTempEquals(dayUse.tmin, thr.valueC);
          }
          notes = `Forecast tmin=${dayUse.tmin}C (hourly)`;
        } else if (type === 'precip_yesno') {
          // use precip probability if available, else infer from precip sum
          if (dayUse.precipProb != null) modelProb = Math.min(1, Math.max(0, dayUse.precipProb / 100));
          else modelProb = sigmoid((dayUse.precip - 0.5) / 0.5);
          notes = `Forecast precip=${dayUse.precip}mm, prob=${dayUse.precipProb ?? 'n/a'}%`;
        } else if (type === 'snow_yesno') {
          // No snow variable in open-meteo daily default; skip for now
          continue;
        } else if (type === 'wind_yesno') {
          // Placeholder: use wind max threshold if present
          const thr = q.match(/(\d+)\s*(mph|km\/h|kph)/i);
          if (!thr) continue;
          const threshold = parseInt(thr[1],10);
          const wind = dayUse.windMax;
          modelProb = sigmoid((wind - threshold) / 2);
          notes = `Forecast wind=${wind}`;
        }

        if (modelProb == null) continue;

        const calib = loadCalibration();
        modelProb = applyCalibration(city.name, type, modelProb, calib);

        const outcomes = JSON.parse(mkt.outcomes || '[]');
        const tokenIds = JSON.parse(mkt.clobTokenIds || '[]');
        const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes');
        const noIdx = outcomes.findIndex(o => o.toLowerCase() === 'no');
        if (yesIdx < 0 || noIdx < 0) continue;
        const yesToken = tokenIds[yesIdx];
        const noToken = tokenIds[noIdx];

        const yesPrice = await clobPrice(yesToken);
        const noPrice = await clobPrice(noToken);

        const edgeYes = modelProb - yesPrice;
        const edgeNo = (1 - modelProb) - noPrice;

        let side = null;
        let price = null;
        let edge = null;

        const url = event.slug ? `https://polymarket.com/event/${event.slug}` : null;

        // Guardrail: avoid markets too close to close
        if (event.endDate) {
          const hrs = (new Date(event.endDate).getTime() - Date.now()) / 36e5;
          if (Number.isFinite(hrs) && hrs >= 0 && hrs < MIN_HOURS_TO_CLOSE) continue;
        }

        if (edgeYes > edgeNo) { side = 'YES'; price = yesPrice; edge = edgeYes; }
        else { side = 'NO'; price = noPrice; edge = edgeNo; }

        // Guardrail: avoid tails using YES probability band (more stable)
        const marketProbYes = yesPrice;
        if (marketProbYes != null && (marketProbYes < MIN_PRICE || marketProbYes > MAX_PRICE)) continue;

        // Require meaningful model vs market disagreement
        if (Math.abs(modelProb - marketProbYes) < MIN_ABS_MODEL_DIFF) continue;

        // Only take trades with sufficient positive edge
        if (edge == null || edge < MIN_EDGE) continue;

        // Risk: daily/city exposure caps
        const sizePct = edge >= 0.10 ? 0.02 : (edge >= 0.05 ? 0.015 : 0.01);
        let stake = bankroll * sizePct;

        const candidateDate = dateStr || localDate;
        const cityDateKey = `${city.name}|${candidateDate}`;

        const dailyCap = bankroll * MAX_DAILY_EXPOSURE_PCT;
        const cityCap = bankroll * MAX_CITY_EXPOSURE_PCT;
        const alreadyDaily = openStakeToday.get(candidateDate) || 0;
        const alreadyCity = openStakeByCityDate.get(cityDateKey) || 0;
        const remainingDaily = Math.max(0, dailyCap - alreadyDaily);
        const remainingCity = Math.max(0, cityCap - alreadyCity);
        stake = Math.max(0, Math.min(stake, remainingDaily, remainingCity));

        if (stopForDay) continue;
        if (stake <= 0.0001) continue;

        const candidate = { city: city.name, q, date: candidateDate, status: 'PAPER_OPEN', side, price, modelProb, edge, sizePct, stake, notes, url, yesPrice, noPrice, station: city.station?.code || '' };
        const key = candidate.date;
        const existingBest = bestByDate.get(key);
        if (!existingBest || candidate.edge > existingBest.edge) bestByDate.set(key, candidate);
      }
    }
    const bestEntries = Array.from(bestByDate.values());
    if (bestEntries.length) {
      bestEntries.forEach(b => {
        const key = `${b.city}|${b.date}`;
        // prevent repeats across runs if we already made ANY non-skip row for this city/date
        if (!existingByCityDate.has(key)) logs.push(b);
      });
    } else {
      const key = `${city.name}|${localDate}`;
      if (!existingByCityDate.has(key)) {
        logs.push({ city: city.name, q: 'No qualifying market', date: localDate, status: 'PAPER_SKIP', notes: 'No qualifying temperature market met filters', url: null });
      }
    }
  }

  for (const log of logs) {
    const abbr = { 'London':'LON','Dallas':'DAL','Atlanta':'ATL','New York City':'NYC','Seoul':'SEL' }[log.city] || log.city;
    const title = `${abbr} | ${log.side ?? 'SKIP'} | ${log.date}`;
    const body = {
      parent: { database_id: 'e1756234-ea9a-40e1-93d7-8493dadc2e00' },
      properties: {
        Name: { title: [{ text: { content: title } }] },
        City: { select: { name: log.city } },
        Station: { rich_text: [{ text: { content: log.station ?? '' } }] },
        Question: { rich_text: [{ text: { content: log.q.slice(0, 2000) } }] },
        MarketURL: { url: log.url ?? null },
        EventDate: { date: { start: log.date } },
        Status: { select: { name: log.status } },
        Notes: { rich_text: [{ text: { content: log.notes ?? '' } }] },
      }
    };
    if (log.status === 'PAPER_OPEN') {
      body.properties.Side = { select: { name: log.side } };
      body.properties.EntryPrice = { number: log.price };
      body.properties.ModelProb = { number: log.modelProb };
      body.properties.Edge = { number: log.edge };
      body.properties.SizePct = { number: log.sizePct };
      body.properties.StakeUsd = { number: log.stake };
    }

    await fetchJson('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${NOTION_KEY}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  }

  // Save logs to a local file for easier access
  fs.writeFileSync('../trades.json', JSON.stringify(logs, null, 2));
  console.log(`Logged ${logs.length} items to Notion and saved to trades.json.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
