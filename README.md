# Polymarket Weather Bot (Paper Trading)

Paper‑trading system for Polymarket weather markets. It discovers city/date weather markets, computes model‑based probabilities from Open‑Meteo hourly forecasts, selects trades, and logs everything to Notion. It also monitors for switches and stop‑loss events and resolves outcomes against Polymarket.

## What it does
- **Market discovery** via Polymarket Gamma public-search using city aliases (NYC, ATL, DFW, etc.)
- **Hourly forecasts** from Open‑Meteo to compute daily max/min
- **Probability model** (normal CDF around threshold/range)
- **Station‑specific matching** (EGLC, KDAL, KATL, KJFK, RKSI)
- **Calibration** (EWMA bias per city & market type)
- **Selection rule**: one trade per city per date, best available edge
- **Risk**: switch rule + stop‑loss
- **Resolution**: pull official Polymarket resolution, update Result/PnL

## Scripts
- `scripts/papertrade-weather.js` — discovery + selection + Notion logging
- `scripts/resolve-papertrades.js` — resolve outcomes + update calibration
- `scripts/switch-monitor.js` — hourly monitor for switch/stop‑loss
- `scripts/daily-summary.js` — daily P/L summary

## Notion
Requires a Notion integration key in:
```
~/.config/notion/api_key
```
The database is expected to be shared with the integration.

## Data & Config
- Calibration stored at: `~/clawd/data/calibration.json`
- Bankroll: $100, position sizing 1–2%

## Stations
- **London**: EGLC
- **Dallas**: KDAL
- **Atlanta**: KATL
- **NYC**: KJFK
- **Seoul**: RKSI

## Changelog

### 2026-02-03
- Added hard trade-quality filters: **minimum edge**, price/probability band, and skip markets too close to close.
- Added basic **risk management**: daily exposure cap, per-city exposure cap, and daily drawdown stop.
- Resolver now handles `PAPER_STOP` and `PAPER_SWITCHED` statuses and writes `PnL` on resolve.
- Added scripts to backfill: `recompute-cumpnl.js`, `fix-resolvedat.js`, and row numbering via `renumber-rows.js`.
- Removed writing the Notion `Source` field (we always use Open-Meteo).
- Stopped writing `ResolvedValue`.
- Daily summary now includes **edge-bucket** performance.

### 2026-02-11
- Added stricter trade filters: require YES market prob in [0.15, 0.85] and |modelProb - marketProb| >= 0.08.
- Added `edge-audit.js` and `rolling-report.js` for ongoing evaluation.

### 2026-02-15
- Prevent duplicates across runs: only one PAPER_SKIP placeholder per city/date; and any existing non-skip row blocks re-opening that city/date.
- Trade **temperature markets only** (highest/lowest temperature), including exact values, ranges, and inequalities.
- Disabled non-temperature market types (precip/wind/etc) for now.

## Notes
- Resolution sources are per Polymarket market descriptions (often Wunderground station history pages).
- This is **paper trading** only.

