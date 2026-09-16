(() => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const state = { series: [] };
  const install = () => {
    const L = window.LightweightCharts;
    if (!L || L.__wajidWrapped) return !!L;
    const original = L.createChart;
    L.createChart = function(...args) {
      const chart = original.apply(this, args);
      window.__wajidChart = chart;
      return chart;
    };
    L.__wajidWrapped = true;
    return true;
  };
  install();

  function clear() {
    const chart = window.__wajidChart;
    if (!chart) return;
    for (const s of state.series) {
      try { chart.removeSeries(s); } catch (_) {}
    }
    state.series = [];
  }

  function drawZone(chart, zone, candles) {
    const start = Number(zone.startTime);
    const end = Number(zone.endTime || candles.at(-1)?.time);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const top = Number(zone.top), bottom = Number(zone.bottom), split = Number(zone.split);
    if (![top,bottom,split].every(Number.isFinite)) return;
    const isBull = Number(zone.trend) === 1;
    const lineColor = isBull ? '#00ffcc' : '#ff007f';
    const splitColor = '#c8c8c8';
    const opts = { lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false };
    const topSeries = chart.addLineSeries({ ...opts, color: lineColor, title: isBull ? 'Bullish OB' : 'Bearish OB' });
    const bottomSeries = chart.addLineSeries({ ...opts, color: lineColor, title: isBull ? 'Bullish OB' : 'Bearish OB' });
    const splitSeries = chart.addLineSeries({ ...opts, color: splitColor, lineStyle: 1, title: 'OB Volume Split' });
    topSeries.setData([{ time: start, value: top }, { time: end, value: top }]);
    bottomSeries.setData([{ time: start, value: bottom }, { time: end, value: bottom }]);
    splitSeries.setData([{ time: start, value: split }, { time: end, value: split }]);
    state.series.push(topSeries, bottomSeries, splitSeries);
  }

  async function loadHistory() {
    for (let i = 0; i < 30 && !window.__wajidChart; i++) await wait(200);
    const chart = window.__wajidChart;
    if (!chart) return;
    const buttons = document.querySelectorAll('[data-tf]');
    let interval = document.querySelector('[data-tf].active')?.dataset.tf || '15min';
    try {
      const r = await fetch(`/api/data?interval=${encodeURIComponent(interval)}&outputsize=300`, { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || !data.success) return;
      const candles = data.candles || [];
      clear();
      for (const zone of (data.volumeOB?.zones || [])) drawZone(chart, zone, candles);
    } catch (_) {}
    buttons.forEach(b => {
      if (b.__obHistoryBound) return;
      b.__obHistoryBound = true;
      b.addEventListener('click', () => {
        interval = b.dataset.tf;
        setTimeout(loadHistory, 350);
      });
    });
  }

  window.addEventListener('load', () => setTimeout(loadHistory, 250));
})();
