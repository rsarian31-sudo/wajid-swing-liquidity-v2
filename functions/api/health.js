export function onRequest() {
  return new Response(JSON.stringify({
    ok: true,
    service: 'wajid-swing-liquidity-v2',
    symbol: 'XAU/USD',
    intervals: ['5min', '15min']
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
