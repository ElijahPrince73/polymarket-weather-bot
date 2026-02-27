# Polymarket Weather Bot Architecture

## Overview
This project is a unified Node.js ESM app that paper-trades weather markets using:
- Polymarket Gamma + CLOB APIs for market discovery and pricing
- Open-Meteo APIs for forecast inputs
- Local SQLite (`better-sqlite3`) for trade state, risk tracking, and calibration

## Runtime Flow
- Entry point: `src/index.js`
- Default mode (`--tick`): `trade -> monitor -> resolve -> summary`
- Individual modes:
  - `--trade`: run market discovery and open/skip logging
  - `--monitor`: run stop-loss and switch checks for open trades
  - `--resolve`: resolve finished markets and update PnL + calibration
  - `--summary`: print daily and rolling stats

## Modules
- `src/config.js`: city/station map, risk filters, search terms, DB path
- `src/db.js`: schema bootstrap and DB access functions
- `src/utils.js`: shared HTTP/retry helpers, probability math, market question parsing
- `src/services/discovery.js`: API discovery/forecast/pricing helpers and calibration application
- `src/services/trader.js`: trade candidate generation, filter/risk checks, best-pick selection
- `src/services/monitor.js`: open-trade monitoring, stop-loss, side switching
- `src/services/resolver.js`: market resolution, result/PnL writeback, EWMA calibration updates
- `src/services/reporter.js`: daily and rolling performance reporting

## Data Model
- `trades` table stores full lifecycle rows with statuses:
  - `OPEN`, `SKIP`, `SWITCHED`, `STOP`, `RESOLVED`
- `result` values:
  - `PENDING`, `WIN`, `LOSS`
- `calibration` table stores per `(city, market_type)` bias, updated via EWMA.

## Notes
- No Notion dependencies remain.
- The app is fully local-state driven (`./data/trades.db`).
- All network reads use the shared retry/timeout wrapper in `utils.fetchJson`.
