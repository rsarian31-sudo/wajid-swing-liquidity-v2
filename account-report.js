(() => {
  const $ = (id) => document.getElementById(id);
  const money = (v) => {
    const n = Number(v || 0);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  };

  const malaysiaDayKey = (ms) => {
    const raw = Number(ms);
    const millis = raw > 0 && raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(millis + 480 * 60000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  };

  const todayMalaysia = () => malaysiaDayKey(Date.now());

  const accountR = (t) => {
    const result = String(t?.result || '').toUpperCase();
    const hits = Array.isArray(t?.hitTPs) ? t.hitTPs : [];
    if (result === 'LOSS') return -1;
    if (result === 'BREAK EVEN') return 0;
    if (result === 'FULL TP HIT' || hits.includes('TP4')) return 4;
    if (result === 'WIN' && (t.reason === 'SL_AFTER_TP2_WIN' || hits.includes('TP2'))) return 1;
    return 0;
  };

  const closedDaily = (trades, dayKey) =>
    (Array.isArray(trades) ? trades : [])
      .filter(t => t?.interval === '1min' && t?.status === 'CLOSED')
      .filter(t => malaysiaDayKey(t.exitTime || t.signalTime || t.createdAt) === dayKey);

  function render(rows) {
    const rs = rows.map(accountR);
    const profit = rs.filter(r => r > 0).reduce((a, r) => a + r * 8, 0);
    const loss = rs.filter(r => r < 0).reduce((a, r) => a + r * 8, 0);
    const net = profit + loss;
    const set = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    set('dailyTrades', rows.length);
    set('dailyProfit', money(profit));
    set('dailyLoss', money(loss));
    set('dailyNet', money(net));
    set('dailyBalance', money(100 + net));
  }

  let allTrades = [];

  async function updateAccountReport() {
    try {
      const r = await fetch('/api/data?interval=1min&outputsize=100', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || !data?.success) return;
      allTrades = Array.isArray(data?.history?.trades) ? data.history.trades : [];
      const dateInput = $('dailyDate');
      if (!dateInput.value) dateInput.value = todayMalaysia();
      render(closedDaily(allTrades, dateInput.value));
    } catch (_) {}
  }

  const dateInput = $('dailyDate');
  if (dateInput) {
    dateInput.value = todayMalaysia();
    dateInput.addEventListener('change', () => {
      render(closedDaily(allTrades, dateInput.value));
    });
  }

  updateAccountReport();
  setInterval(updateAccountReport, 60000);
})();