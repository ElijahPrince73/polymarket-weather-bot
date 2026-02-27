function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJson(url, opts = {}) {
  const {
    retries = 3,
    retryDelayMs = 1500,
    timeoutMs = 12000,
    ...fetchOpts
  } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...fetchOpts, signal: controller.signal });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} for ${url}${txt ? ` :: ${txt}` : ""}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(retryDelayMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

export function probTempEquals(forecast, threshold, sigma = 1.5) {
  const z1 = ((threshold - 0.5) - forecast) / sigma;
  const z2 = ((threshold + 0.5) - forecast) / sigma;
  return Math.max(0, Math.min(1, normalCdf(z2) - normalCdf(z1)));
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export function fmtDateInTz(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function monthNumber(name) {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const i = months.indexOf(String(name).toLowerCase());
  return i >= 0 ? i + 1 : null;
}

export function parseDateFromQuestion(question, tz) {
  const match = String(question).match(
    /(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})/i
  );
  if (!match) return null;

  const monthStr = match[1];
  const day = parseInt(match[2], 10);
  const monthMap = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const month = monthMap[monthStr.slice(0, 3).toLowerCase()] ?? monthNumber(monthStr);
  if (!month) return null;
  const year = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(new Date());
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function fToC(f) {
  return ((f - 32) * 5) / 9;
}

export function parseThresholdC(question) {
  let m = String(question).match(/(-?\d+)\s*°?C/i);
  if (m) return { valueC: parseFloat(m[1]), unit: "C" };
  m = String(question).match(/(-?\d+)\s*°?F/i);
  if (m) return { valueC: fToC(parseFloat(m[1])), unit: "F" };
  return null;
}

export function parseRangeC(question) {
  let m = String(question).match(/(-?\d+)\s*[-–]\s*(-?\d+)\s*°?C/i);
  if (m) return { lowC: parseFloat(m[1]), highC: parseFloat(m[2]), unit: "C" };
  m = String(question).match(/(-?\d+)\s*[-–]\s*(-?\d+)\s*°?F/i);
  if (m) return { lowC: fToC(parseFloat(m[1])), highC: fToC(parseFloat(m[2])), unit: "F" };
  return null;
}

export function parseInequalityC(question) {
  let m = String(question).match(/(-?\d+)\s*°?C\s*(or\s+below|or\s+lower|or\s+less)/i);
  if (m) return { valueC: parseFloat(m[1]), op: "le" };
  m = String(question).match(/(-?\d+)\s*°?C\s*(or\s+higher|or\s+above|or\s+more)/i);
  if (m) return { valueC: parseFloat(m[1]), op: "ge" };
  m = String(question).match(/(-?\d+)\s*°?F\s*(or\s+below|or\s+lower|or\s+less)/i);
  if (m) return { valueC: fToC(parseFloat(m[1])), op: "le" };
  m = String(question).match(/(-?\d+)\s*°?F\s*(or\s+higher|or\s+above|or\s+more)/i);
  if (m) return { valueC: fToC(parseFloat(m[1])), op: "ge" };
  return null;
}

export function detectMarketType(question) {
  const q = String(question).toLowerCase();
  if (q.includes("highest temperature")) return "temp_max";
  if (q.includes("lowest temperature")) return "temp_min";
  if (q.includes("rain") || q.includes("precipitation")) return "precip_yesno";
  if (q.includes("snow")) return "snow_yesno";
  if (q.includes("wind")) return "wind_yesno";
  return null;
}

export function isTemperatureQuestion(question) {
  const q = String(question).toLowerCase();
  return q.includes("highest temperature") || q.includes("lowest temperature");
}
