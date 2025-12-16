export default function handler(req, res) {
  const body = req.body || {};

  // --- Handshake (must match spec) ---
  if (body.handshake === true) {
    return res.status(200).json({
      ok: true,
      student_email: "agonts",
      algorithm_name: "BullwhipBreakerPlus",
      version: "v1.0.0",
      supports: { blackbox: true, glassbox: true },
      message: "BeerBot ready"
    });
  }

  const mode = body.mode || "blackbox";
  const weeks = Array.isArray(body.weeks) ? body.weeks : [];
  const last = weeks.length ? weeks[weeks.length - 1] : null;

  const roles = ["retailer", "wholesaler", "distributor", "factory"];

  // ---------- helpers ----------
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const iround = (x) => {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.floor(x + 0.5));
  };

  // Extract time series for a role: demand, arrivals, our past orders
  function seriesFor(role) {
    const d = [];
    const a = [];
    const o = [];
    for (const w of weeks) {
      const r = w?.roles?.[role];
      const ord = w?.orders?.[role];
      d.push(Number.isFinite(r?.incoming_orders) ? r.incoming_orders : 0);
      a.push(Number.isFinite(r?.arriving_shipments) ? r.arriving_shipments : 0);
      o.push(Number.isFinite(ord) ? ord : 0);
    }
    return { d, a, o };
  }

  function ema(values, alpha) {
    let m = 0;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      m = (i === 0) ? x : (alpha * x + (1 - alpha) * m);
    }
    return m;
  }

  function emaMad(values, alpha) {
    // EMA of absolute deviation from EMA mean (robust scale proxy)
    let m = 0;
    let mad = 0;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      m = (i === 0) ? x : (alpha * x + (1 - alpha) * m);
      const dev = Math.abs(x - m);
      mad = (i === 0) ? dev : (alpha * dev + (1 - alpha) * mad);
    }
    return { m, mad };
  }

  function estimateLeadTime(arrivals, orders) {
    // Deterministic lag selection: choose L in [1..6] minimizing SSE
    // arrivals[t] ≈ orders[t-L]
    const maxL = 6;
    const minL = 1;
    const n = Math.min(arrivals.length, orders.length);
    if (n < 6) return 2; // default when too little history

    let bestL = 2;
    let bestErr = Infinity;

    for (let L = minL; L <= maxL; L++) {
      let err = 0;
      let cnt = 0;
      // use last up to 12 points
      const start = Math.max(0, n - 12);
      for (let t = start; t < n; t++) {
        const idx = t - L;
        if (idx < 0) continue;
        const pred = orders[idx];
        const y = arrivals[t];
        const e = y - pred;
        err += e * e;
        cnt++;
      }
      if (cnt > 0) {
        const mse = err / cnt;
        if (mse < bestErr) {
          bestErr = mse;
          bestL = L;
        }
      }
    }
    return bestL;
  }

  function computeOrder(role, useGlobalForecast, globalForecast, globalMad) {
    const { d, a, o } = seriesFor(role);
    const alpha = 0.25;      // demand smoothing
    const beta = 0.50;       // order smoothing
    const z = 1.0;           // safety factor (moderate)

    const stats = emaMad(d, alpha);
    const forecast = useGlobalForecast ? globalForecast : stats.m;
    const mad = useGlobalForecast ? globalMad : stats.mad;

    const L = estimateLeadTime(a, o);

    const rNow = last?.roles?.[role] || {};
    const inventory = Number.isFinite(rNow.inventory) ? rNow.inventory : 0;
    const backlog = Number.isFinite(rNow.backlog) ? rNow.backlog : 0;

    const net = inventory - backlog;

    // outstanding orders: last (L-1) orders (placed but not yet arrived)
    let outstanding = 0;
    const n = o.length;
    for (let k = 1; k <= (L - 1); k++) {
      const idx = n - k;
      if (idx >= 0) outstanding += o[idx];
    }

    const IP = net + outstanding;

    const safety = iround(z * mad * Math.sqrt(L + 1));
    const S = forecast * (L + 1) + safety;

    const desired = S - IP;

    const prevOrder = (n >= 1) ? o[n - 1] : 0;
    const smoothed = beta * desired + (1 - beta) * prevOrder;

    const up = iround(0.5 * forecast + 2);
    const down = iround(0.7 * forecast + 2);
    const limited = clamp(smoothed, prevOrder - down, prevOrder + up);

    return iround(limited);
  }

  // ---------- global forecast for glassbox ----------
  let globalForecast = 0;
  let globalMad = 0;
  if (mode === "glassbox") {
    const { d } = seriesFor("retailer");
    const stats = emaMad(d, 0.25);
    globalForecast = stats.m;
    globalMad = stats.mad;
  }

  const ordersOut = {};
  for (const role of roles) {
    const useGlobal = (mode === "glassbox");
    ordersOut[role] = computeOrder(role, useGlobal, globalForecast, globalMad);
  }

  return res.status(200).json({ orders: ordersOut });
}
