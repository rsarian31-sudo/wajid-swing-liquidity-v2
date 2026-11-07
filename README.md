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
- TP1 = 1R milestone; TP2 = 2R milestone (never a completed trade — a trade stays open until TP4 or SL)
- SL before TP2 = LOSS (-1R)
- Same-candle SL + TP2 = LOSS conservatively
- Gold maximum stop filter = $10 for history
- Signals run 24/7; if no valid setup, NO TRADE

## Cloudflare secret
Set `TWELVE_DATA_API_KEY` as a Pages/Workers environment variable. Never commit the key to Git. Note: Twelve Data Basic is internal non-display only — its licensing for production Telegram signals is not confirmed.
