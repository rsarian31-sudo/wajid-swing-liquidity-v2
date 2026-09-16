// Client-side safety guard only. Does not alter server strategy mathematics.
(() => {
  function patchCharts() {
    const LC = window.LightweightCharts;
    if (!LC || LC.__wajidZeroSafetyPatched) return;

    const nativeCreateChart = LC.createChart;
    LC.createChart = function (...args) {
      const chart = nativeCreateChart.apply(this, args);
      const nativeAddLineSeries = chart.addLineSeries.bind(chart);
      chart.addLineSeries = function (...seriesArgs) {
        const series = nativeAddLineSeries(...seriesArgs);
        const nativeSetData = series.setData.bind(series);
        series.setData = function (data) {
          if (Array.isArray(data)) {
            data = data.filter(point => {
              const value = Number(point?.value);
              return Number.isFinite(value) && value > 0;
            });
          }
          return nativeSetData(data);
        };
        return series;
      };
      return chart;
    };
    LC.__wajidZeroSafetyPatched = true;
  }

  function cleanTradeLabels() {
    ['entry', 'sl', 'tp1', 'tp2', 'tp3', 'risk'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.textContent.trim() === '0.00') el.textContent = '—';
    });
  }

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
        fields.every(field => Number.isFinite(Number(plan[field])) && Number(plan[field]) > 0)
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

  patchCharts();
  cleanTradeLabels();
  new MutationObserver(cleanTradeLabels).observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true
  });
  setInterval(cleanTradeLabels, 1000);
})();
