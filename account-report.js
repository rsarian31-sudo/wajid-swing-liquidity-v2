(() => {
  const $ = (id) => document.getElementById(id);
  const money = (v) => {
    const n = Number(v || 0);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  };
  async function updateAccountReport() {
    try {
      const r = await fetch('/api/data?interval=1min&outputsize=100', { cache: 'no-store' });
      const data = await r.json();
      if (!r.ok || !data?.success) return;
      const report = data.accountReport || {};
      for (const [prefix, item] of [['daily', report.daily || {}], ['weekly', report.weekly || {}]]) {
        const set = (id, value) => {
          const el = $(id);
          if (el) el.textContent = value;
        };
        set(prefix + 'Trades', item.trades ?? 0);
        set(prefix + 'Profit', money(item.profit));
        set(prefix + 'Loss', money(item.loss));
        set(prefix + 'Net', money(item.net));
        set(prefix + 'Balance', money(item.currentBalance ?? 100));
      }
    } catch (_) {}
  }
  updateAccountReport();
  setInterval(updateAccountReport, 60000);
})();
