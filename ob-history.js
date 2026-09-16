(() => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const state = { series: [], zones: [], overlay: null, hidden: false, interval: null };

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

  function css() {
    if (document.getElementById('wajid-chart-ui-css')) return;
    const style = document.createElement('style');
    style.id = 'wajid-chart-ui-css';
    style.textContent = `
      .wajid-chart-shell{position:relative}
      .wajid-chart-tools{display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin:0 0 8px;padding:6px;border:1px solid #173b55;border-radius:9px;background:#071522}
      .wajid-chart-tools .tool-label{font-size:10px;color:#607a90;margin:0 5px 0 2px;letter-spacing:.5px}
      .wajid-chart-tools button{border:1px solid #204866;background:#091b2a;color:#91a8ba;border-radius:6px;padding:5px 8px;font:600 10px Inter,system-ui,sans-serif;cursor:pointer}
      .wajid-chart-tools button:hover,.wajid-chart-tools button.active{background:#1188e8;border-color:#168fff;color:#fff}
      .wajid-chart-legend{position:absolute;z-index:10;left:10px;top:8px;display:flex;gap:9px;align-items:center;pointer-events:none;padding:6px 8px;border:1px solid rgba(34,72,99,.8);border-radius:7px;background:rgba(4,12,20,.84);backdrop-filter:blur(5px);font:600 10px Inter,system-ui,sans-serif;color:#dbe7f0}
      .wajid-chart-legend .muted{color:#7890a4;font-weight:500}.wajid-chart-legend .price{color:#f0c44f}.wajid-chart-legend .dot{width:6px;height:6px;border-radius:50%;background:#35dfa0;box-shadow:0 0 7px #35dfa0}
      .wajid-ob-zone{position:absolute;z-index:4;border:1px dashed;pointer-events:none;opacity:.12;border-radius:2px}
      .wajid-ob-zone.bull{background:#00ffcc;border-color:#00ffcc}.wajid-ob-zone.bear{background:#ff007f;border-color:#ff007f}
      .wajid-ob-zone.hidden{display:none}
      .wajid-chart-fullscreen{position:fixed!important;inset:10px!important;width:auto!important;height:auto!important;z-index:99999!important;background:#030810!important;padding:14px!important;border-radius:12px!important}
      .wajid-chart-fullscreen #chart{height:calc(100vh - 90px)!important}
      @media(max-width:600px){.wajid-chart-tools{overflow-x:auto;flex-wrap:nowrap}.wajid-chart-tools .tool-label{display:none}.wajid-chart-legend{font-size:9px;max-width:calc(100% - 20px)}}`;
    document.head.appendChild(style);
  }

  function setupShell() {
    css();
    const chart = document.getElementById('chart');
    if (!chart || chart.parentElement?.classList.contains('wajid-chart-shell')) return;
    const shell = chart.parentElement;
    shell.classList.add('wajid-chart-shell');
    const tools = document.createElement('div');
    tools.className = 'wajid-chart-tools';
    tools.innerHTML = `<span class="tool-label">CHART</span><button data-wj="fit">FIT</button><button data-wj="reset">RESET</button><button data-wj="cross" class="active">CROSSHAIR</button><button data-wj="ob">OB HISTORY</button><button data-wj="full">FULLSCREEN</button>`;
    shell.insertBefore(tools, chart);
    const legend = document.createElement('div');
    legend.className = 'wajid-chart-legend';
    legend.innerHTML = `<span>XAU/USD</span><span class="muted" data-wj-legend="tf">15M</span><span class="dot"></span><span class="muted" data-wj-legend="provider">LIVE</span><span class="price" data-wj-legend="price">—</span>`;
    chart.appendChild(legend);
    tools.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-wj]');
      if (!button) return;
      const action = button.dataset.wj;
      const c = window.__wajidChart;
      if (!c) return;
      if (action === 'fit') c.timeScale().fitContent();
      if (action === 'reset') { c.priceScale('right').applyOptions({ autoScale: true }); c.timeScale().fitContent(); }
      if (action === 'cross') {
        const active = button.classList.toggle('active');
        c.applyOptions({ crosshair: { mode: active ? window.LightweightCharts.CrosshairMode.Normal : window.LightweightCharts.CrosshairMode.Hidden } });
      }
      if (action === 'ob') {
        state.hidden = !state.hidden;
        button.classList.toggle('active', !state.hidden);
        state.series.forEach(s => { try { s.applyOptions({ visible: !state.hidden }); } catch (_) {} });
        state.zones.forEach(z => z.classList.toggle('hidden', state.hidden));
      }
      if (action === 'full') {
        const card = chart.closest('.chart-card');
        if (!card) return;
        card.classList.toggle('wajid-chart-fullscreen');
        button.classList.toggle('active', card.classList.contains('wajid-chart-fullscreen'));
        setTimeout(() => c.applyOptions({width: chart.clientWidth, height: chart.clientHeight}), 80);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.querySelector('.wajid-chart-fullscreen')?.classList.remove('wajid-chart-fullscreen');
    });
  }

  function clear() {
    const chart = window.__wajidChart;
    if (!chart) return;
    for (const s of state.series) { try { chart.removeSeries(s); } catch (_) {} }
    state.series = [];
    state.zones.forEach(z => z.remove());
    state.zones = [];
  }

  function drawZoneLines(chart, zone, candles) {
    const start = Number(zone.startTime), end = Number(zone.endTime || candles.at(-1)?.time);
    const top = Number(zone.top), bottom = Number(zone.bottom), split = Number(zone.split);
    if (![start,end,top,bottom,split].every(Number.isFinite)) return;
    const bull = Number(zone.trend) === 1;
    const color = bull ? '#00ffcc' : '#ff007f';
    const opts = { lineWidth:1, lineStyle:2, priceLineVisible:false, lastValueVisible:false };
    const a = chart.addLineSeries({...opts,color,title:bull?'Bullish OB':'Bearish OB'});
    const b = chart.addLineSeries({...opts,color,title:bull?'Bullish OB':'Bearish OB'});
    const s = chart.addLineSeries({...opts,color:'#c8c8c8',lineStyle:1,title:'OB Volume Split'});
    a.setData([{time:start,value:top},{time:end,value:top}]);
    b.setData([{time:start,value:bottom},{time:end,value:bottom}]);
    s.setData([{time:start,value:split},{time:end,value:split}]);
    state.series.push(a,b,s);
  }

  function drawZoneBoxes(chart, zones) {
    const host = document.getElementById('chart');
    if (!host) return;
    zones.forEach(zone => {
      const top = Number(zone.top), bottom = Number(zone.bottom), start = Number(zone.startTime), end = Number(zone.endTime || zone.lastTime);
      if (![top,bottom,start,end].every(Number.isFinite)) return;
      const el = document.createElement('div');
      el.className = `wajid-ob-zone ${Number(zone.trend)===1?'bull':'bear'}`;
      el.dataset.start = start; el.dataset.end = end; el.dataset.top = top; el.dataset.bottom = bottom;
      host.appendChild(el); state.zones.push(el);
    });
    positionBoxes(chart);
  }

  function positionBoxes(chart) {
    const host = document.getElementById('chart');
    if (!host) return;
    const ts = chart.timeScale();
    const ps = chart.priceScale('right');
    state.zones.forEach(el => {
      const x1 = ts.timeToCoordinate(Number(el.dataset.start));
      const x2 = ts.timeToCoordinate(Number(el.dataset.end));
      const y1 = ps.priceToCoordinate(Number(el.dataset.top));
      const y2 = ps.priceToCoordinate(Number(el.dataset.bottom));
      if ([x1,x2,y1,y2].some(v => v === null || v === undefined || !Number.isFinite(v))) { el.style.display='none'; return; }
      const left = Math.min(x1,x2), top = Math.min(y1,y2), width = Math.max(2,Math.abs(x2-x1)), height = Math.max(2,Math.abs(y2-y1));
      el.style.display = state.hidden ? 'none' : 'block'; el.style.left=`${left}px`; el.style.top=`${top}px`; el.style.width=`${width}px`; el.style.height=`${height}px`;
    });
  }

  function updateLegend(data, interval) {
    document.querySelector('[data-wj-legend="tf"]')?.replaceChildren(document.createTextNode(interval === '5min' ? '5M' : '15M'));
    document.querySelector('[data-wj-legend="provider"]')?.replaceChildren(document.createTextNode(data?.dataProvider?.name || 'LIVE'));
    const candles = data?.candles || [];
    const last = candles.at(-1)?.close;
    document.querySelector('[data-wj-legend="price"]')?.replaceChildren(document.createTextNode(Number.isFinite(Number(last)) ? Number(last).toFixed(2) : '—'));
  }

  async function loadHistory(interval) {
    for (let i=0;i<30 && !window.__wajidChart;i++) await wait(200);
    const chart = window.__wajidChart; if (!chart) return;
    setupShell();
    state.interval = interval || document.querySelector('[data-tf].active')?.dataset.tf || '15min';
    try {
      const r = await fetch(`/api/data?interval=${encodeURIComponent(state.interval)}&outputsize=300`, {cache:'no-store'});
      const data = await r.json(); if (!r.ok || !data.success) return;
      clear();
      const candles = data.candles || [];
      const zones = data.volumeOB?.zones || [];
      zones.forEach(z => drawZoneLines(chart,z,candles));
      drawZoneBoxes(chart,zones);
      updateLegend(data,state.interval);
      positionBoxes(chart);
    } catch (_) {}
  }

  async function boot() {
    for (let i=0;i<40 && !window.__wajidChart;i++) await wait(150);
    setupShell();
    const initial = document.querySelector('[data-tf].active')?.dataset.tf || '15min';
    await loadHistory(initial);
    document.querySelectorAll('[data-tf]').forEach(b => {
      if (b.__wajidOBBound) return;
      b.__wajidOBBound = true;
      b.addEventListener('click', () => setTimeout(() => loadHistory(b.dataset.tf), 400));
    });
    const chart = window.__wajidChart;
    if (chart) {
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => positionBoxes(chart));
      chart.timeScale().subscribeVisibleTimeRangeChange(() => positionBoxes(chart));
    }
    window.addEventListener('resize', () => chart && positionBoxes(chart));
    window.__wajidOBHistory = { reload: loadHistory, clear };
  }

  window.addEventListener('load', () => setTimeout(boot, 250));
})();
