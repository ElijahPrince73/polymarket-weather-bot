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

## Notes
- Resolution sources are per Polymarket market descriptions (often Wunderground station history pages).
- This is **paper trading** only.

