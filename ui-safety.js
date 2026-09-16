// Client-side safety guard: invalid zero/negative trade plans must never be
// rendered as live ENTRY/SL/TP values. This does not alter server strategy math.
(() => {
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = String(args[0]?.url || args[0] || '');
    if (!url.includes('/api/data')) return response;

    try {
      const payload = await response.clone().json();
      const plan = payload?.tradePlan;
      const fields = ['entry', 'stopLoss', 'tp1', 'tp2', 'tp3'];
      const validPlan = Boolean(
        payload?.activeTrade &&
        plan &&
        fields.every((field) => Number.isFinite(Number(plan[field])) && Number(plan[field]) > 0)
      );

      if (!validPlan) {
        payload.activeTrade = null;
        payload.tradePlan = null;
      }

      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (_) {
      return response;
    }
  };
})();
