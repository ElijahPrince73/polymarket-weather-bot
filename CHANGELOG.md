# CHANGELOG

## 2026-02-28 — Live Polymarket CLOB Integration

### Production Trading
- **New:** `src/services/exchange.js` — CLOB client (buy/sell/cancel/balance)
  - Uses `@polymarket/clob-client` + `ethers@5` + `dotenv`
  - Same wallet credentials as BTC bot (shared .env)
  - `isLiveMode()` checks `TRADING_MODE` env var (default: paper)
- **Updated** `src/db.js`:
  - Added columns: `token_id`, `order_id`, `fill_size`, `condition_id`, `neg_risk`
  - Migration auto-runs ALTER TABLE (safe for existing DBs)
  - `getBankroll()` now async — returns live USDC balance in live mode
- **Updated** `src/services/trader.js`:
  - Stores `token_id`, `condition_id`, `neg_risk` on each trade candidate
  - In live mode: places real GTC BUY orders via CLOB after discovery
  - Uses real USDC balance for position sizing in live mode
- **Updated** `src/services/monitor.js`:
  - Stop-loss + switch now place SELL orders in live mode
- **Updated** `src/server.js`:
  - `/api/status` includes `tradingMode`, `liveBalance`
  - `POST /api/kill` — emergency kill switch (cancels all CLOB orders, stops all trades)
  - `POST /api/mode` — display mode toggle
- **Updated** `public/index.html`:
  - PAPER (yellow) / LIVE (green) badge in header
  - Red KILL SWITCH button (visible in live mode)
  - Shows live USDC balance when in live mode
- **Created** `.env.example` with all required env vars
- **Added** `.env` to `.gitignore`
- **Dependencies:** `@polymarket/clob-client`, `ethers@5`, `dotenv`

### How to Go Live
1. Ensure `.env` has valid CLOB credentials (copied from BTC bot)
2. Change `TRADING_MODE=live` in `.env`
3. Restart: `npm start`
4. Bot will use real USDC balance and place real orders
5. Kill switch available on dashboard or `POST /api/kill`


## 2026-02-27 — Full Rewrite & Upgrades

### Phase 1: Project Rewrite (from scratch)
- **Deleted** `polymarket_weather_alert.py` (obsolete Python version)
- **Deleted** `polymarket_state.json` (old state file)
- **Deleted** all legacy scripts in `scripts/` (12 files — papertrade, resolve, switch-monitor, daily-summary, edge-audit, rolling-report, etc.)
- **Created** unified Node.js ESM app in `src/`:
  - `src/config.js` — cities, trading params, search terms, DB path
  - `src/db.js` — SQLite via better-sqlite3, trades + calibration tables
  - `src/utils.js` — shared helpers (fetchJson with retry, normalCdf, temperature parsing, date formatting)
  - `src/services/discovery.js` — Polymarket Gamma search, CLOB prices, Open-Meteo forecasts, calibration
  - `src/services/trader.js` — market discovery + trade selection + risk management
  - `src/services/monitor.js` — stop-loss (20% drop) + switch detection (edge flip)
  - `src/services/resolver.js` — resolution against Polymarket outcomes, PnL calc, EWMA calibration update
  - `src/services/reporter.js` — daily summary + 30-day rolling report
  - `src/index.js` — CLI entry (`--tick`, `--trade`, `--monitor`, `--resolve`, `--summary`)
- **Replaced Notion** with local SQLite (`./data/trades.db`)
- **Standardized** on ESM (`type: module`) throughout
- **Single tick** runs full cycle: discover → monitor → resolve → report

### Phase 2: Dashboard
- **Created** `src/server.js` — Express server on port 3001
  - `GET /api/status` — bankroll, open trades, uptime, last tick
  - `GET /api/trades` — all trades (supports `?status=OPEN`)
  - `GET /api/trades/:id` — single trade
  - `GET /api/summary` — daily + rolling 30d stats
  - `GET /api/calibration` — calibration bias per city/type
  - `POST /api/tick` — manual tick trigger
  - Auto tick every 30 minutes + on startup
  - Graceful shutdown (SIGINT/SIGTERM closes DB)
- **Created** `public/index.html` — dark theme vanilla JS dashboard
  - Stats bar: bankroll, open trades, win rate, PnL, ROI
  - Open Positions table (with event date in MM/DD format)
  - Recent Resolved table
  - Performance by City breakdown
  - Edge Bucket Performance
  - Calibration table
  - Activity log
  - Auto-refresh every 60 seconds, mobile responsive
- **Updated** `package.json`:
  - `start` → `node src/server.js`
  - `dev` → `node --watch src/server.js`
  - Added express dependency

### Phase 3: Model & Sizing Upgrades
- **Multi-model forecast blending** (`forecastHourlyBlended`)
  - Fetches hourly temps from multiple weather models per city via Open-Meteo `&models=` param
  - Takes median tmax/tmin across successful models
  - Falls back to default single model if all fail
  - Model candidates per region:
    - US cities: HRRR, NAM CONUS, ECMWF IFS 0.25°, GFS 0.25°
    - London: UKMO UK Deterministic, ICON EU, ECMWF, GFS
    - Seoul: ECMWF, ICON Global, GFS
- **Added 7 new cities** (12 total):
  - Chicago (KORD), Miami (KMIA), Houston (KIAH), Phoenix (KPHX), Denver (KDEN), Los Angeles (KLAX), San Francisco (KSFO)
- **Half-Kelly position sizing** replaced flat 1-2% tiers:
  - `kellySize = (p * payoff - (1-p)) / payoff / 2`
  - Clamped to 1-8% of bankroll
  - High-edge trades now get up to $8 (on $100 bankroll) vs old $2
- **Bumped exposure caps**:
  - Daily: 5% → 15%
  - Per-city: 2% → 6%

### First Run Results (2026-02-27)
- 9 initial trades opened (London, Dallas, Atlanta, NYC, Seoul — old 5 cities)
- After upgrades: Chicago + Miami trades opened at $6/each (Kelly sizing)
- Houston, Phoenix, Denver, LA, SF showed no qualifying markets (may not have active Polymarket weather markets yet)
- Seoul trade hit stop-loss
- Model blending active (1-4 models depending on time of day and availability)

## Architecture
```
src/
  config.js          — cities, params, model candidates
  db.js              — SQLite schema + query functions
  utils.js           — shared math/parsing/fetch helpers
  index.js           — CLI entry point
  server.js          — Express dashboard + auto tick loop
  services/
    discovery.js     — market search, forecasts, blending, calibration
    trader.js        — trade selection + Kelly sizing + risk caps
    monitor.js       — stop-loss + switch detection
    resolver.js      — outcome resolution + PnL + EWMA calibration
    reporter.js      — daily + rolling reports
public/
  index.html         — dark theme dashboard UI
data/
  trades.db          — SQLite database (gitignored)
```
