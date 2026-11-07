# Wajid Swing Liquidity v2

BTC + Gold SMC signal system — BTCUSDT (Bitget) and XAU/USD signals, delivered via Telegram only. $0/month (free services only).

## Architecture
- Frontend: HTML, CSS, vanilla JavaScript (`index.html` = Gold, `btc.html` = BTC)
- Chart: Lightweight Charts
- Backend: Cloudflare Worker / Pages Functions
- Market data: Bitget public market data (BTC spot, free, no key); Twelve Data (Gold)
- Cache: Cloudflare Cache API
- Strategy: canonical server-side Swing Liquidity engine (Liquidity Sweep → MSS → BOS → Order Block → FVG → Confirmation → Entry, candle-close only)

## Rules
- Gold 5M and 15M only; BTC 15M, 30M and 1H only (no 1M signals)
- Strategy mathematics must not be changed without explicit approval
- Frontend never calculates signals
- TP1 = 1R milestone (SL moves to Entry); TP2 = 2R milestone, TP3 = 3R milestone — the trade stays OPEN until TP4 or SL; TP2 is never a completed trade
- SL before TP1 = LOSS (-1R); SL at Entry after TP1 = BREAK-EVEN (0R); TP4 = completed successfully
- Same-candle TP and SL both touched: ordering is open (A2) — current code keeps the repo's TP-first status quo; do not assume
- Signals run 24/7; if no valid setup, NO TRADE

## Cloudflare secrets / environment
Set as Pages/Workers environment variables (never commit values to Git):
- `TWELVE_DATA_API_KEY` — Gold feed. Note: Twelve Data Basic is internal non-display only — its licensing for production Telegram signals is not confirmed.
- `TELEGRAM_BOT_TOKEN` — existing bot (reuse; do not create a second bot).
- `TELEGRAM_CHANNEL_ID` — Premium Channel ID (env secret preferred; the worker falls back to the existing channel constant).
- `LIVE_SIGNALS_ENABLED` — `false` by default (paper mode: signals are logged, nothing is sent to Telegram). Set to `true` ONLY after paper trading is reviewed and the owner explicitly approves live activation.

## Backtest
`node scripts/smc-backtest.mjs --days 30 --paper-days 7` — per-pipeline SMC backtest (BTC via Bitget public candles, Gold via the getdata-finance XAUUSD 1m CSV). Results in `scripts/smc-backtest-results.json`. Note the honest limits: Bitget V3 `/candles` only serves roughly the last 30 days via endTime paging (verified 2026-11-07), and the Gold CSV was last updated 2026-09-25.
