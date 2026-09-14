import { DurableObject } from 'cloudflare:workers';

const EMPTY = () => ({
  version: 1,
  intervals: {
    '5min': { active: null, trades: [], lastSignalId: null, lastCandleTime: null },
    '15min': { active: null, trades: [], lastSignalId: null, lastCandleTime: null }
  }
});

export class WajidTradeState extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    let state = await this.ctx.storage.get('state');
    if (!state) state = EMPTY();

    if (request.method === 'GET') {
      return json(state);
    }

    if (request.method === 'POST' && url.pathname === '/replace') {
      const body = await request.json();
      if (!body || typeof body !== 'object') return json({ error: 'Invalid state' }, 400);
      await this.ctx.storage.put('state', body);
      return json(body);
    }

    return json({ error: 'Not found' }, 404);
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
