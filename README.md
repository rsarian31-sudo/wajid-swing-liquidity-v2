# Wajid Swing Liquidity v2

Gold-only XAU/USD trading dashboard.

## Architecture
- Frontend: HTML, CSS, vanilla JavaScript
- Chart: Lightweight Charts
- Backend: Cloudflare Pages Functions
- Market data: Twelve Data
- Cache: Cloudflare Cache API
- Strategy: canonical server-side Swing Liquidity engine

## Rules
- XAU/USD only
- 5M and 15M only
- Strategy mathematics must not be changed without explicit approval
- Frontend never calculates signals
- TP1 = 1R milestone
- TP2 = official WIN (+2R)
- SL before TP2 = LOSS (-1R)
- Same-candle SL + TP2 = LOSS conservatively
- Gold maximum stop filter = $10 for history

## Cloudflare secret
Set `TWELVE_DATA_API_KEY` as a Pages/Workers environment variable. Never commit the key to Git.
