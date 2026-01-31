#!/usr/bin/env python3
import json
import re
import sys
from datetime import datetime, date
from zoneinfo import ZoneInfo
from typing import Dict, Any, List
import requests
import statistics
import time
import os

PT = ZoneInfo("America/Los_Angeles")

CITIES = {
    "london": {"lat": 51.5072, "lon": -0.1276, "tz": "Europe/London"},
    "dallas": {"lat": 32.7767, "lon": -96.7970, "tz": "America/Chicago"},
    "atlanta": {"lat": 33.7490, "lon": -84.3880, "tz": "America/New_York"},
    "seoul": {"lat": 37.5665, "lon": 126.9780, "tz": "Asia/Seoul"},
    "new york": {"lat": 40.7128, "lon": -74.0060, "tz": "America/New_York"},
}

MODEL_CANDIDATES = {
    "london": ["ukmo_ukv", "icon_eu", "arome", "ecmwf"],
    "dallas": ["hrrr", "nam", "ecmwf", "gfs"],
    "atlanta": ["hrrr", "nam", "ecmwf", "gfs"],
    "seoul": ["kma", "ecmwf", "icon", "gfs"],
    "new york": ["hrrr", "nam", "ecmwf", "gfs"],
}

BASE_EVENT_URL = "https://polymarket.com/event/"
STATE_PATH = "/Users/elijahprince/clawd/polymarket_state.json"
NOTION_DB_ID = os.getenv("NOTION_DB_ID")
NOTION_KEY_PATH = os.path.expanduser("~/.config/notion/api_key")

WU_STATIONS = {
    "london": "https://www.wunderground.com/history/daily/gb/london/EGLL",
    "dallas": "https://www.wunderground.com/history/daily/us/tx/dallas/KDAL",
    "atlanta": "https://www.wunderground.com/history/daily/us/ga/atlanta/KATL",
    "seoul": "https://www.wunderground.com/history/daily/kr/incheon/RKSI",
    "new york": "https://www.wunderground.com/history/daily/us/ny/new-york-city/KJFK",
}


def today_slug_date(dt: datetime) -> str:
    return dt.strftime("%B %-d").lower().replace(" ", "-")


def fetch_event_markets(slug: str) -> List[Dict[str, Any]]:
    html = None
    for _ in range(3):
        try:
            html = requests.get(BASE_EVENT_URL + slug, timeout=20).text
            break
        except Exception:
            time.sleep(1.5)
    if html is None:
        return []
    marker = '"markets":['
    start = html.find(marker)
    if start == -1:
        return []
    i = start + len('"markets":')
    if html[i] != '[':
        return []
    depth = 0
    end = None
    for j in range(i, len(html)):
        ch = html[j]
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    if end is None:
        return []
    arr_text = html[i:end]
    try:
        markets = json.loads(arr_text)
        return markets
    except Exception:
        return []


def parse_market_bucket(question: str):
    unit = "C"
    if "°F" in question:
        unit = "F"
    m = re.search(r"be\s+(-?\d+)°[CF]\s+or\s+below", question)
    if m:
        return ("<=", int(m.group(1)), unit)
    m = re.search(r"be\s+(-?\d+)°[CF]\s+or\s+above", question)
    if m:
        return (">=", int(m.group(1)), unit)
    m = re.search(r"be\s+(-?\d+)°[CF]\b", question)
    if m:
        return ("=", int(m.group(1)), unit)
    return None


def c_to_f(c: float) -> float:
    return c * 9/5 + 32


def pick_market(markets: List[Dict[str, Any]], forecast_c: float):
    # filter active markets
    active = [m for m in markets if m.get("active")]
    if not active:
        active = markets

    buckets = []
    for m in active:
        q = m.get("question", "")
        b = parse_market_bucket(q)
        if b:
            buckets.append((b, m))

    def target_for(unit: str):
        return int(round(c_to_f(forecast_c))) if unit == "F" else int(round(forecast_c))

    # pick closest bucket by distance to target (with inequality handling)
    best = None
    best_dist = 1e9
    for (op, val, unit), m in buckets:
        target = target_for(unit)
        if op == "=":
            dist = abs(target - val)
        elif op == "<=":
            dist = 0 if target <= val else abs(target - val)
        elif op == ">=":
            dist = 0 if target >= val else abs(target - val)
        else:
            dist = abs(target - val)
        if dist < best_dist:
            best_dist = dist
            best = m
    return best or (active[0] if active else None)


def forecast_max_temp_c(city: str):
    info = CITIES[city]
    tz = info["tz"]
    today_local = datetime.now(ZoneInfo(tz)).date()
    url = "https://api.open-meteo.com/v1/forecast"

    def fetch_for_model(model: str):
        params = {
            "latitude": info["lat"],
            "longitude": info["lon"],
            "hourly": "temperature_2m",
            "timezone": tz,
            "model": model,
        }
        for _ in range(3):
            try:
                r = requests.get(url, params=params, timeout=20)
                if r.status_code != 200:
                    time.sleep(1.5)
                    continue
                data = r.json()
                break
            except Exception:
                time.sleep(1.5)
                data = None
        if not data:
            return None
        times = data["hourly"]["time"]
        temps = data["hourly"]["temperature_2m"]
        max_t = None
        for t, temp in zip(times, temps):
            d = datetime.fromisoformat(t).date()
            if d == today_local:
                max_t = temp if max_t is None else max(max_t, temp)
        return max_t

    # Try model blending
    values = []
    for model in MODEL_CANDIDATES.get(city, []):
        v = fetch_for_model(model)
        if v is not None:
            values.append(v)
    if values:
        return statistics.median(values)

    # Fallback to default model
    params = {
        "latitude": info["lat"],
        "longitude": info["lon"],
        "hourly": "temperature_2m",
        "timezone": tz,
    }
    data = None
    for _ in range(3):
        try:
            r = requests.get(url, params=params, timeout=20)
            if r.status_code != 200:
                time.sleep(1.5)
                continue
            data = r.json()
            break
        except Exception:
            time.sleep(1.5)
    if not data:
        return None
    times = data["hourly"]["time"]
    temps = data["hourly"]["temperature_2m"]
    max_t = None
    for t, temp in zip(times, temps):
        d = datetime.fromisoformat(t).date()
        if d == today_local:
            max_t = temp if max_t is None else max(max_t, temp)
    return max_t


def wunderground_max_f(city: str):
    url = WU_STATIONS.get(city)
    if not url:
        return None, "wu: no url"
    try:
        html = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"}).text
    except Exception as e:
        return None, f"wu: fetch failed ({e.__class__.__name__})"
    # look for 'Max Temperature' or 'High'
    m = re.search(r"Max Temperature\s*</span>\s*<span[^>]*>(-?\d+)", html)
    if not m:
        m = re.search(r"High\s*</span>\s*<span[^>]*>(-?\d+)", html)
    if not m:
        return None, "wu: parse failed"
    try:
        return float(m.group(1)), None
    except Exception:
        return None, "wu: parse failed"


def format_prices(market: Dict[str, Any]):
    prices = market.get("outcomePrices") or []
    if len(prices) >= 2:
        yes = float(prices[0])
        no = float(prices[1])
        return yes, no
    return None, None


def load_state():
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, "r") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f)


def notion_key():
    if os.path.exists(NOTION_KEY_PATH):
        return open(NOTION_KEY_PATH).read().strip()
    return None


def log_to_notion(entry: Dict[str, Any]):
    if not NOTION_DB_ID:
        return
    key = notion_key()
    if not key:
        return
    url = "https://api.notion.com/v1/pages"
    headers = {
        "Authorization": f"Bearer {key}",
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
    }
    body = {
        "parent": {"database_id": NOTION_DB_ID},
        "properties": {
            "Name": {"title": [{"text": {"content": entry["name"]}}]},
            "Date": {"date": {"start": entry["date_iso"]}},
            "City": {"select": {"name": entry["city"]}},
            "Forecast_F": {"number": entry["forecast_f"]},
            "Market": {"url": entry["market_url"]},
            "Bucket": {"rich_text": [{"text": {"content": entry["bucket"]}}]},
            "Yes": {"number": entry["yes"] if entry["yes"] is not None else 0},
            "No": {"number": entry["no"] if entry["no"] is not None else 0},
            "Decision": {"select": {"name": entry["decision"]}},
            "Outcome": {"select": {"name": "OPEN"}},
        },
    }
    requests.post(url, headers=headers, data=json.dumps(body))


def build_alert_for_city(city: str):
    slug_date = today_slug_date(datetime.now(PT))
    slug_city = city.replace(" ", "-")
    slug = f"highest-temperature-in-{slug_city}-on-{slug_date}"
    markets = fetch_event_markets(slug)
    if not markets:
        return None, f"**{city.upper()}** No market data found for slug: {slug}"
    max_c = forecast_max_temp_c(city)
    if max_c is None:
        return None, f"**{city.upper()}** No forecast data"
    max_f = c_to_f(max_c)
    wu_f, wu_err = wunderground_max_f(city)
    wu_used = False
    wu_note = "WU: no"
    if wu_f is not None:
        max_f = (max_f + wu_f) / 2.0
        max_c = (max_f - 32) * 5/9
        wu_used = True
        wu_note = "WU: yes"
    else:
        if wu_err:
            wu_note = wu_err
    market = pick_market(markets, max_c)
    if not market:
        return None, f"**{city.upper()}** No matching market bucket"
    yes, no = format_prices(market)
    # skip completed/fully priced markets
    if yes in (0.0, 1.0) or no in (0.0, 1.0) or market.get("closed"):
        return None, f"**{city.upper()}** Skipped (market already resolved or priced 0/1)"
    link = BASE_EVENT_URL + slug

    max_f = c_to_f(max_c)
    line = f"**{city.upper()}** Forecast max: {max_f:.1f}°F (target ~{int(round(max_f))}°F) [{wu_note}]"
    q = market.get("question", "")
    if yes is not None:
        line2 = f"Market: {q} | Yes {yes:.2f} / No {no:.2f}"
    else:
        line2 = f"Market: {q}"

    b = parse_market_bucket(q)
    decision = "N/A"
    if b:
        op, val, unit = b
        target = int(round(max_f)) if unit == "F" else int(round(max_c))
        if (op == "=" and target == val) or (op == "<=" and target <= val) or (op == ">=" and target >= val):
            decision = "YES"
        else:
            decision = "NO"
    line_decision = f"Recommended bucket (closest to forecast): {q}"

    line3 = f"Open market:\n<{link}>"
    alert = "\n".join([line, line2, line_decision, line3])

    entry = {
        "name": f"{city.title()} {slug_date}",
        "date_iso": datetime.now(PT).date().isoformat(),
        "city": city.title() if city != "new york" else "New York",
        "forecast_f": round(max_f, 1),
        "market_url": link,
        "bucket": q,
        "yes": yes,
        "no": no,
        "decision": decision,
    }
    return entry, alert


def main():
    mode = os.getenv("MODE", "monitor")  # monitor | summary
    state = load_state()
    today = datetime.now(PT).date().isoformat()
    if today not in state:
        state[today] = {}

    if mode == "summary":
        alerts = []
        for city, data in state.get(today, {}).items():
            alerts.append(data.get("alert", f"**{city.upper()}** No data"))
        if alerts:
            print("\n\n".join(alerts))
        else:
            print("No paper-trade positions recorded today.")
        return

    # monitor mode
    for city in ["london", "dallas", "atlanta", "seoul", "new york"]:
        entry, alert = build_alert_for_city(city)
        if entry is None:
            continue
        # log once per day per city
        if city not in state[today]:
            state[today][city] = {"alert": alert, "entry": entry}
            log_to_notion(entry)
    save_state(state)

if __name__ == "__main__":
    main()
