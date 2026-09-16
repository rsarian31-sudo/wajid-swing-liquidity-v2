// UI safety only. Never changes Swing Liquidity strategy mathematics.
// XAU/USD trade levels cannot legitimately be 0; block accidental zero values
// from being rendered as active trade levels or forcing the chart scale to zero.
(function () {
  function patchCharts() {
    const LC = window.LightweightCharts;
    if (!LC || LC.__wajidZeroSafetyPatched) return;
    const originalCreateChart = LC.createChart;
    LC.createChart = function (...args) {
      const chart = originalCreateChart.apply(this, args);
      const originalAddLineSeries = chart.addLineSeries.bind(chart);
      chart.addLineSeries = function (...seriesArgs) {
        const series = originalAddLineSeries(...seriesArgs);
        const originalSetData = series.setData.bind(series);
        series.setData = function (data) {
          const safe = Array.isArray(data)
            ? data.filter(point => Number.isFinite(Number(point?.value)) && Number(point.value) > 0)
            : data;
          return originalSetData(safe);
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
      if (!el) return;
      if (el.textContent.trim() === '0.00') el.textContent = '—';
    });
  }

  patchCharts();
  cleanTradeLabels();
  new MutationObserver(cleanTradeLabels).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  setInterval(cleanTradeLabels, 1000);
})();
