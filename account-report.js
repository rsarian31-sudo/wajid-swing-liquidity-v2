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
    if (result === 'FULL TP HIT' || result === 'FINAL TP4 HIT' || hits.includes('TP4')) return 4;
    if (result === 'TP2 HIT CLOSE' || result === 'TP3 HIT CLOSE') return 1;
    if (result === 'WIN' && (t.reason === 'SL_AFTER_TP2_WIN' || hits.includes('TP2'))) return 1;
    return 0;
  };

  const closedDaily = (trades, dayKey) =>
    (Array.isArray(trades) ? trades : [])
      .filter(t => t?.interval === '1min' && t?.status === 'CLOSED')
      .filter(t => malaysiaDayKey(t.exitTime || t.signalTime || t.createdAt) === dayKey);

  function renderCalculator(rows) {
    const balanceEl = $('calcBalance');
    const riskEl = $('calcRisk');
    if (!balanceEl || !riskEl) return;
    let balance = Number(balanceEl.value);
    let riskPct = Number(riskEl.value);
    if (!Number.isFinite(balance) || balance <= 0) balance = 100;
    if (!Number.isFinite(riskPct) || riskPct <= 0) riskPct = 2;
    riskPct = Math.min(100, riskPct);
    const oneR = balance * riskPct / 100;
    const rs = rows.map(accountR);
    const profitR = rs.filter(r => r > 0).reduce((a, r) => a + r, 0);
    const lossR = rs.filter(r => r < 0).reduce((a, r) => a + r, 0);
    const netR = profitR + lossR;
    const set = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    set('calcRiskUsd', money(oneR));
    set('calcProfitUsd', money(profitR * oneR));
    set('calcLossUsd', money(lossR * oneR));
    set('calcNetUsd', money(netR * oneR));
    set('calcBalanceOut', money(balance + netR * oneR));
    set('calcTrades', rows.length);
  }

  function render(rows, allClosed) {
    const rs = rows.map(accountR);
    const profit = rs.filter(r => r > 0).reduce((a, r) => a + r * 8, 0);
    const loss = rs.filter(r => r < 0).reduce((a, r) => a + r * 8, 0);
    const net = profit + loss;
    const selectedEnd = rows.reduce((max, t) => Math.max(max, Number(t.exitTime || t.signalTime || t.createdAt || 0)), 0);
    const cumulative = (Array.isArray(allClosed) ? allClosed : [])
      .filter(t => Number(t.exitTime || t.signalTime || t.createdAt || 0) <= selectedEnd)
      .reduce((sum, t) => sum + accountR(t) * 8, 0);
    const set = (id, value) => {
      const el = $(id);
      if (el) el.textContent = value;
    };
    set('dailyTrades', rows.length);
    set('dailyProfit', money(profit));
    set('dailyLoss', money(loss));
    set('dailyNet', money(net));
    set('dailyBalance', money(100 + net));
    set('perfBalance', money(100 + cumulative));
    renderCalculator(rows);
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
      const rows = closedDaily(allTrades, dateInput.value);
      const allClosed = (Array.isArray(allTrades) ? allTrades : [])
        .filter(t => t?.interval === '1min' && t?.status === 'CLOSED');
      const target = rows.length ? Math.max(...rows.map(t => Number(t.exitTime || t.signalTime || t.createdAt || 0))) : Date.parse(dateInput.value + 'T23:59:59Z');
      const cumulativeRows = allClosed.filter(t => Number(t.exitTime || t.signalTime || t.createdAt || 0) <= target);
      render(rows, cumulativeRows);
    } catch (_) {}
  }

  const dateInput = $('dailyDate');
  if (dateInput) {
    dateInput.value = todayMalaysia();
    dateInput.addEventListener('change', () => {
      const rows = closedDaily(allTrades, dateInput.value);
      const allClosed = (Array.isArray(allTrades) ? allTrades : [])
        .filter(t => t?.interval === '1min' && t?.status === 'CLOSED');
      const target = rows.length ? Math.max(...rows.map(t => Number(t.exitTime || t.signalTime || t.createdAt || 0))) : Date.parse(dateInput.value + 'T23:59:59Z');
      const cumulativeRows = allClosed.filter(t => Number(t.exitTime || t.signalTime || t.createdAt || 0) <= target);
      render(rows, cumulativeRows);
    });
  }

  ['calcBalance','calcRisk'].forEach(id => {
    const el = $(id);
    if (!el) return;
    const saved = localStorage.getItem('wajid_'+id);
    if (saved !== null) el.value = (id === 'calcRisk' && saved === '8') ? '2' : saved;
    else if (id === 'calcRisk') el.value = '2';
    el.addEventListener('input', () => {
      localStorage.setItem('wajid_'+id, el.value);
      const dateInput = $('dailyDate');
      const rows = closedDaily(allTrades, dateInput?.value || todayMalaysia());
      renderCalculator(rows);
    });
  });

  updateAccountReport();
  setInterval(updateAccountReport, 60000);
})();