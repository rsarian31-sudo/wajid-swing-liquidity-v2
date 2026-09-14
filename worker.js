import { onRequest as dataRequest } from './functions/api/data.js';
import { onRequest as healthRequest } from './functions/api/health.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      return dataRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    }

    if (url.pathname === '/api/health') {
      return healthRequest({ request, env, waitUntil: ctx.waitUntil.bind(ctx) });
    }

    return env.ASSETS.fetch(request);
  }
};
