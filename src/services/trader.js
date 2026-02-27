import {
  BASE_BANKROLL,
  CITIES,
  MODEL_CANDIDATES,
  MAX_CITY_EXPOSURE_PCT,
  MAX_DAILY_EXPOSURE_PCT,
  MAX_PRICE,
  MIN_ABS_MODEL_DIFF,
  MIN_EDGE,
  MIN_HOURS_TO_CLOSE,
  MIN_PRICE,
  STOP_DAILY_DD_PCT,
} from "../config.js";
import db, { sqlite } from "../db.js";
import {
  applyCalibration,
  clobPrice,
  forecastDaily,
  forecastHourlyBlended,
  pickDailyForDate,
  searchMarkets,
} from "./discovery.js";
import {
  detectMarketType,
  fmtDateInTz,
  isTemperatureQuestion,
  normalCdf,
  parseDateFromQuestion,
  parseInequalityC,
  parseRangeC,
  parseThresholdC,
  probTempEquals,
} from "../utils.js";

function parseJsonArray(s) {
  try {
    return JSON.parse(s || "[]");
  } catch {
    return [];
  }
}

function kellySize(modelProb, entryPrice, side) {
  const p = side === "YES" ? modelProb : 1 - modelProb;
  const payoff = 1 / entryPrice - 1;
  const kelly = (p * payoff - (1 - p)) / payoff;
  const halfKelly = kelly / 2;
  return Math.max(0.01, Math.min(0.08, halfKelly));
}

export async function runTradeDiscovery(dbApi = db) {
  const bankroll = dbApi.getBankroll();
  const todayPnl = dbApi.getTodayResolvedPnl();
  const stopForDay = todayPnl <= -STOP_DAILY_DD_PCT * bankroll;

  const rows = sqlite
    .prepare(`SELECT city, event_date, status, stake_usd FROM trades`)
    .all();
  const anyRowByCityDate = new Set();
  const nonSkipByCityDate = new Set();
  const openStakeByCityDate = new Map();
  const openStakeToday = new Map();

  for (const row of rows) {
    if (!row.city || !row.event_date) continue;
    const key = `${row.city}|${row.event_date}`;
    anyRowByCityDate.add(key);
    if (row.status && row.status !== "SKIP") nonSkipByCityDate.add(key);
    if (row.status === "OPEN") {
      const stake = row.stake_usd ?? 0;
      openStakeByCityDate.set(key, (openStakeByCityDate.get(key) ?? 0) + stake);
      openStakeToday.set(row.event_date, (openStakeToday.get(row.event_date) ?? 0) + stake);
    }
  }

  const logs = [];
  for (const city of CITIES) {
    const localDate = fmtDateInTz(city.tz);
    const [daily, blendedTemps] = await Promise.all([
      forecastDaily(city.lat, city.lon, city.tz),
      forecastHourlyBlended(city.lat, city.lon, city.tz, MODEL_CANDIDATES[city.name] ?? []),
    ]);
    const day = pickDailyForDate(daily.daily, localDate);
    if (!day && !blendedTemps) continue;

    const dayUse = {
      tmax: blendedTemps?.tmax ?? day?.tmax,
      tmin: blendedTemps?.tmin ?? day?.tmin,
      windMax: day?.windMax ?? null,
      precip: day?.precip ?? null,
      precipProb: day?.precipProb ?? null,
    };

    const events = await searchMarkets(city.aliases);
    const bestByDate = new Map();
    for (const event of events) {
      if (event.closed || !Array.isArray(event.markets)) continue;
      const eventDate = event.endDate ? event.endDate.slice(0, 10) : null;

      for (const market of event.markets) {
        if (market.closed || !market.active) continue;
        const question = market.question || "";
        const qLower = question.toLowerCase();
        const aliasMatch = city.aliases.some((a) => qLower.includes(a.toLowerCase()));
        if (!aliasMatch) continue;

        const dateStr = parseDateFromQuestion(question, city.tz) || eventDate;
        if (dateStr && dateStr < localDate) continue;

        const type = detectMarketType(question);
        if (!type || !isTemperatureQuestion(question)) continue;
        if (type !== "temp_max" && type !== "temp_min") continue;

        let modelProb = null;
        let notes = "";
        if (type === "temp_max") {
          const range = parseRangeC(question);
          const ineq = parseInequalityC(question);
          if (range) {
            const sigma = 1.5;
            const z1 = (range.lowC - dayUse.tmax) / sigma;
            const z2 = (range.highC - dayUse.tmax) / sigma;
            modelProb = Math.max(0, Math.min(1, normalCdf(z2) - normalCdf(z1)));
          } else if (ineq) {
            const sigma = 1.5;
            const z = (ineq.valueC - dayUse.tmax) / sigma;
            modelProb = ineq.op === "le" ? normalCdf(z) : 1 - normalCdf(z);
          } else {
            const thr = parseThresholdC(question);
            if (!thr) continue;
            modelProb = probTempEquals(dayUse.tmax, thr.valueC);
          }
          notes = `Forecast tmax=${dayUse.tmax}C (Blended ${blendedTemps?.modelsUsed ?? 0} models)`;
        } else {
          const range = parseRangeC(question);
          const ineq = parseInequalityC(question);
          if (range) {
            const sigma = 1.5;
            const z1 = (range.lowC - dayUse.tmin) / sigma;
            const z2 = (range.highC - dayUse.tmin) / sigma;
            modelProb = Math.max(0, Math.min(1, normalCdf(z2) - normalCdf(z1)));
          } else if (ineq) {
            const sigma = 1.5;
            const z = (ineq.valueC - dayUse.tmin) / sigma;
            modelProb = ineq.op === "le" ? normalCdf(z) : 1 - normalCdf(z);
          } else {
            const thr = parseThresholdC(question);
            if (!thr) continue;
            modelProb = probTempEquals(dayUse.tmin, thr.valueC);
          }
          notes = `Forecast tmin=${dayUse.tmin}C (Blended ${blendedTemps?.modelsUsed ?? 0} models)`;
        }
        if (modelProb == null) continue;
        modelProb = applyCalibration(city.name, type, modelProb);

        const outcomes = parseJsonArray(market.outcomes);
        const tokenIds = parseJsonArray(market.clobTokenIds);
        const outcomePrices = parseJsonArray(market.outcomePrices);
        const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
        const noIdx = outcomes.findIndex((o) => String(o).toLowerCase() === "no");
        if (yesIdx < 0 || noIdx < 0) continue;

        let yesPrice = Number.parseFloat(outcomePrices[yesIdx]);
        let noPrice = Number.parseFloat(outcomePrices[noIdx]);
        if (tokenIds[yesIdx]) {
          try {
            yesPrice = await clobPrice(tokenIds[yesIdx]);
          } catch {}
        }
        if (tokenIds[noIdx]) {
          try {
            noPrice = await clobPrice(tokenIds[noIdx]);
          } catch {}
        }
        if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) continue;

        if (event.endDate) {
          const hrs = (new Date(event.endDate).getTime() - Date.now()) / 36e5;
          if (Number.isFinite(hrs) && hrs >= 0 && hrs < MIN_HOURS_TO_CLOSE) continue;
        }

        const edgeYes = modelProb - yesPrice;
        const edgeNo = 1 - modelProb - noPrice;
        const side = edgeYes > edgeNo ? "YES" : "NO";
        const price = side === "YES" ? yesPrice : noPrice;
        const edge = side === "YES" ? edgeYes : edgeNo;
        const marketProbYes = yesPrice;

        if (marketProbYes < MIN_PRICE || marketProbYes > MAX_PRICE) continue;
        if (Math.abs(modelProb - marketProbYes) < MIN_ABS_MODEL_DIFF) continue;
        if (edge < MIN_EDGE) continue;

        const sizePct = kellySize(modelProb, price, side);
        let stakeUsd = bankroll * sizePct;
        const candidateDate = dateStr || localDate;
        const cityDateKey = `${city.name}|${candidateDate}`;
        const dailyCap = bankroll * MAX_DAILY_EXPOSURE_PCT;
        const cityCap = bankroll * MAX_CITY_EXPOSURE_PCT;
        const remainingDaily = Math.max(0, dailyCap - (openStakeToday.get(candidateDate) ?? 0));
        const remainingCity = Math.max(0, cityCap - (openStakeByCityDate.get(cityDateKey) ?? 0));
        stakeUsd = Math.max(0, Math.min(stakeUsd, remainingDaily, remainingCity));

        if (stopForDay || stakeUsd <= 0.0001) continue;

        const candidate = {
          city: city.name,
          station: city.station,
          question,
          market_url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
          event_date: candidateDate,
          side,
          entry_price: price,
          model_prob: modelProb,
          edge,
          size_pct: sizePct,
          stake_usd: stakeUsd,
          status: "OPEN",
          result: "PENDING",
          notes,
        };
        const currentBest = bestByDate.get(candidateDate);
        if (!currentBest || candidate.edge > currentBest.edge) bestByDate.set(candidateDate, candidate);
      }
    }

    const bestEntries = [...bestByDate.values()];
    if (bestEntries.length) {
      for (const entry of bestEntries) {
        const key = `${entry.city}|${entry.event_date}`;
        if (!nonSkipByCityDate.has(key)) logs.push(entry);
      }
    } else {
      const key = `${city.name}|${localDate}`;
      if (!anyRowByCityDate.has(key)) {
        logs.push({
          city: city.name,
          station: city.station,
          question: "No qualifying market",
          market_url: null,
          event_date: localDate,
          status: "SKIP",
          result: "PENDING",
          notes: "No qualifying temperature market met filters",
        });
      }
    }
  }

  for (const log of logs) dbApi.insertTrade(log);
  return { openedOrLogged: logs.length, stopForDay, bankroll: bankroll || BASE_BANKROLL };
}
