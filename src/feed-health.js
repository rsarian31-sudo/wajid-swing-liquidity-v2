// Shared candle validation + feed health for Gold and BTC.
// HEALTHY   — data is usable for new signals.
// DEGRADED  — data has issues (small gaps, minor anomalies); new signals are
//             still allowed but the issue is recorded and surfaced.
// HALTED    — data is unusable (stale, too few candles, broken OHLC, huge
//             jump). New signal generation for that market/interval is
//             DISABLED until the feed recovers. Never silently fall back to
//             another provider.

export function validateCandles(candles, intervalSeconds, opts = {}) {
  const issues = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const list = Array.isArray(candles) ? candles : [];
  const minClosed = opts.minClosed ?? 50;

  if (!list.length) {
    return { health: 'HALTED', issues: ['NO_CANDLES'], closedCount: 0, lastTime: null, gapCount: 0, maxJumpPct: 0 };
  }

  // 1. Finite, positive, well-formed OHLC.
  let bad = 0;
  for (const c of list) {
    const ok =
      Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) &&
      Number.isFinite(c.low) && Number.isFinite(c.close) &&
      c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
      c.high >= Math.max(c.open, c.close) - 1e-9 && c.low <= Math.min(c.open, c.close) + 1e-9;
    if (!ok) bad++;
  }
  if (bad) issues.push(`BAD_OHLC:${bad}`);

  // 2. Sorted, unique, interval-aligned timestamps.
  let dup = 0, unsorted = 0, misaligned = 0;
  const seen = new Set();
  let prev = -Infinity;
  for (const c of list) {
    if (seen.has(c.time)) dup++;
    seen.add(c.time);
    if (c.time < prev) unsorted++;
    prev = Math.max(prev, c.time);
    if (intervalSeconds && c.time % intervalSeconds !== 0) misaligned++;
  }
  if (dup) issues.push(`DUPLICATE_TIMESTAMPS:${dup}`);
  if (unsorted) issues.push('UNSORTED');
  if (misaligned) issues.push(`MISALIGNED_TIMESTAMPS:${misaligned}`);

  // 3. Gaps in the closed-candle sequence.
  let gapCount = 0;
  const sorted = [...list].sort((a, b) => a.time - b.time);
  for (let i = 1; i < sorted.length; i++) {
    const diff = sorted[i].time - sorted[i - 1].time;
    if (diff > intervalSeconds) gapCount += Math.round(diff / intervalSeconds) - 1;
  }
  if (gapCount) issues.push(`MISSING_CANDLES:${gapCount}`);

  // 4. Abnormal single-candle movement (>5% close-to-close is not normal for
  // BTC or Gold on these timeframes; it indicates bad data, not a market move
  // the strategy should trade).
  let maxJumpPct = 0;
  for (let i = 1; i < sorted.length; i++) {
    const jump = Math.abs(sorted[i].close - sorted[i - 1].close) / sorted[i - 1].close;
    if (jump > maxJumpPct) maxJumpPct = jump;
  }
  if (maxJumpPct > 0.05) issues.push(`ABNORMAL_MOVE:${(maxJumpPct * 100).toFixed(2)}%`);

  // 5. Staleness: the last candle must have closed recently.
  const lastTime = sorted.at(-1)?.time ?? null;
  const stalenessSec = lastTime == null ? Infinity : nowSec - lastTime;
  if (lastTime == null || stalenessSec > intervalSeconds * 3) {
    issues.push(`STALE:${Number.isFinite(stalenessSec) ? stalenessSec : 'inf'}s`);
  }

  // 6. Enough closed candles.
  const closedCount = sorted.filter(c => c.time + intervalSeconds <= nowSec).length;
  if (closedCount < minClosed) issues.push(`INSUFFICIENT_CLOSED:${closedCount}<${minClosed}`);

  const halted =
    issues.some(i => i.startsWith('NO_CANDLES') || i.startsWith('STALE') ||
      i.startsWith('INSUFFICIENT_CLOSED') || i.startsWith('ABNORMAL_MOVE') ||
      i.startsWith('BAD_OHLC') || i.startsWith('UNSORTED'));
  const degraded = !halted && issues.length > 0;
  return {
    health: halted ? 'HALTED' : degraded ? 'DEGRADED' : 'HEALTHY',
    issues,
    closedCount,
    lastTime,
    gapCount,
    maxJumpPct: Number(maxJumpPct.toFixed(6)),
  };
}

// Split a raw candle list into closed candles and the forming candle.
// A candle is closed only when its full interval has elapsed.
export function splitClosed(candles, intervalSeconds, nowSec = Math.floor(Date.now() / 1000)) {
  const sorted = [...(candles || [])].sort((a, b) => a.time - b.time);
  const closed = sorted.filter(c => c.time + intervalSeconds <= nowSec);
  const current = sorted.length && sorted.at(-1).time + intervalSeconds > nowSec ? sorted.at(-1) : null;
  return { closed, current };
}
