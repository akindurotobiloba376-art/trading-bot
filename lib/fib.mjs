// SMC Fib Zone v5.1 - JavaScript port of the Pine script.
// Candles: { t: openTimeMs, o, h, l, c } oldest first, closed candles only.

export const FIB_DEFAULTS = {
  dir: "Both", // Both, Long only, Short only
  len: 5, // pivot length
  zs: 0.618, // zone start (fib)
  ze: 0.786, // zone end (fib)
  tpExt: 1.0, // target: 1.0 = swing extreme
  slATR: 1.5, // stop distance beyond pullback (x ATR)
  buf: 0.3, // minimum stop buffer (price)
  useFri: true, // skip new entries late Friday
  friHour: 17, // Friday cutoff hour (UTC)
  useTimeExit: false,
  holdHrs: 5,
  useTrend: false, // EMA trend filter
  emaLen: 200,
  minLegATR: 0,
  maxAge: 100, // setup expiry (bars)
  pip: 0.1,
  // Extra filters that are NOT in the Pine script. Both 0 = off = exact TradingView rules.
  minRewUsd: 0, // skip setups whose reward is under this many dollars
  minRR: 0, // skip setups whose reward / risk is under this ratio
};

// Pine ta.atr(14): RMA of true range
function atrSeries(c, len) {
  const out = new Array(c.length).fill(NaN);
  let sum = 0;
  let rma = NaN;
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    const tr =
      i === 0
        ? k.h - k.l
        : Math.max(k.h - k.l, Math.abs(k.h - c[i - 1].c), Math.abs(k.l - c[i - 1].c));
    if (i < len - 1) {
      sum += tr;
      continue;
    }
    if (i === len - 1) {
      sum += tr;
      rma = sum / len;
    } else {
      rma = (rma * (len - 1) + tr) / len;
    }
    out[i] = rma;
  }
  return out;
}

function emaSeries(v, len) {
  const out = new Array(v.length).fill(NaN);
  const a = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    prev = Number.isNaN(prev) ? v[i] : a * v[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

// pivot value confirmed at bar i (looks len bars back and len bars forward)
function pivotHigh(c, i, len) {
  const b = i - len;
  if (b - len < 0) return NaN;
  const h = c[b].h;
  for (let j = 1; j <= len; j++) {
    if (c[b - j].h >= h) return NaN; // left side strictly lower
    if (c[b + j].h > h) return NaN; // right side not higher
  }
  return h;
}
function pivotLow(c, i, len) {
  const b = i - len;
  if (b - len < 0) return NaN;
  const l = c[b].l;
  for (let j = 1; j <= len; j++) {
    if (c[b - j].l <= l) return NaN;
    if (c[b + j].l < l) return NaN;
  }
  return l;
}

const minLow = (c, i, n) => {
  let m = Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, c[j].l);
  return m;
};
const maxHigh = (c, i, n) => {
  let m = -Infinity;
  for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, c[j].h);
  return m;
};

export function fibTrades(candles, userCfg = {}, tfMs = 3600000) {
  const cfg = { ...FIB_DEFAULTS, ...userCfg };
  const n = candles.length;
  const { len, zs, ze, tpExt, slATR, buf, minLegATR, maxAge } = cfg;
  const allowL = cfg.dir !== "Short only";
  const allowS = cfg.dir !== "Long only";
  const maxBars = Math.max(1, Math.ceil((cfg.holdHrs * 3600000) / tfMs));

  const atr = atrSeries(candles, 14);
  const ema = emaSeries(
    candles.map((k) => k.c),
    cfg.emaLen
  );

  let dir = 0;
  let ent = NaN, sl = NaN, tp = NaN;
  let held = 0;
  let entryIdx = -1;
  let lastPH = NaN, lastPL = NaN, lastPiv = 0;
  let lSH = NaN, lSL = NaN, lPB = NaN, lAge = 0, lAct = false;
  let sHi = NaN, sLo = NaN, sPB = NaN, sAge = 0, sAct = false;
  const trades = [];

  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const atrV = atr[i];

    // 1) manage the open trade
    held = dir !== 0 ? held + 1 : 0;
    const hitSL = dir === 1 ? k.l <= sl : dir === -1 ? k.h >= sl : false;
    const hitTP = dir === 1 ? k.h >= tp : dir === -1 ? k.l <= tp : false;
    const closeSL = hitSL;
    const closeTP = hitTP && !hitSL;
    const closeTO = cfg.useTimeExit && dir !== 0 && held >= maxBars && !hitSL && !hitTP;
    if (closeSL || closeTP || closeTO) {
      let exit = k.c;
      if (closeTP) exit = tp;
      if (closeSL) {
        exit = sl;
        // gap through the stop: the fill is at the open, which is worse
        if (dir === 1 && k.o < sl) exit = k.o;
        if (dir === -1 && k.o > sl) exit = k.o;
      }
      trades.push({
        i: entryIdx,
        j: i,
        dir,
        entry: ent,
        sl,
        tp,
        exit,
        why: closeTP ? "tp" : closeSL ? "sl" : "time",
        pips: ((exit - ent) * dir) / cfg.pip,
        held: i - entryIdx,
      });
      dir = 0;
    }

    // 2) pivots and setups
    const ph = pivotHigh(candles, i, len);
    const pl = pivotLow(candles, i, len);
    const phNew = !Number.isNaN(ph);
    const plNew = !Number.isNaN(pl);
    const lowN = minLow(candles, i, len + 1);
    const highN = maxHigh(candles, i, len + 1);

    const longRaw = phNew && lastPiv === -1;
    const shortRaw = plNew && lastPiv === 1;
    const longNew = longRaw && ph - lastPL >= minLegATR * atrV;
    const shortNew = shortRaw && lastPH - pl >= minLegATR * atrV;

    if (longNew) {
      lSH = ph;
      lSL = lastPL;
    }
    lAge = longNew ? 0 : lAge + 1;
    lPB = longNew ? lowN : lAct ? Math.min(lPB, k.l) : lPB;
    lAct = longNew || (lAct && !longRaw);

    if (shortNew) {
      sLo = pl;
      sHi = lastPH;
    }
    sAge = shortNew ? 0 : sAge + 1;
    sPB = shortNew ? highN : sAct ? Math.max(sPB, k.h) : sPB;
    sAct = shortNew || (sAct && !shortRaw);

    if (phNew) lastPH = ph;
    if (plNew) lastPL = pl;
    lastPiv = phNew ? 1 : plNew ? -1 : lastPiv;

    // 3) zones, stops, targets
    const lRng = lSH - lSL;
    const lZT = lSH - lRng * zs;
    const lZB = lSH - lRng * ze;
    const sRng = sHi - sLo;
    const sZB = sLo + sRng * zs;
    const sZT = sLo + sRng * ze;

    const slDist = Math.max(buf, slATR * atrV);
    const slL = lPB - slDist;
    const tpL = lPB + tpExt * (lSH - lPB);
    const slS = sPB + slDist;
    const tpS = sPB - tpExt * (sPB - sLo);

    // optional reward filters (off by default)
    const rewL = tpL - k.c;
    const rewS = k.c - tpS;
    const rewOkL =
      (cfg.minRewUsd <= 0 || rewL >= cfg.minRewUsd) &&
      (cfg.minRR <= 0 || rewL >= cfg.minRR * (k.c - slL));
    const rewOkS =
      (cfg.minRewUsd <= 0 || rewS >= cfg.minRewUsd) &&
      (cfg.minRR <= 0 || rewS >= cfg.minRR * (slS - k.c));

    // 4) entries (closed candle)
    const d = new Date(k.t);
    const friOK = !(
      cfg.useFri &&
      d.getUTCDay() === 5 &&
      d.getUTCHours() >= cfg.friHour
    );
    const trendUp = !cfg.useTrend || k.c > ema[i];
    const trendDn = !cfg.useTrend || k.c < ema[i];

    const longSig =
      allowL && trendUp && friOK && dir === 0 && lAct &&
      k.l <= lZT && k.h >= lZB && k.l >= lSL && k.c > k.o && k.c > lZB &&
      tpL > k.c && !Number.isNaN(slL) && rewOkL;
    const shortSig =
      allowS && trendDn && friOK && dir === 0 && sAct &&
      k.h >= sZB && k.l <= sZT && k.h <= sHi && k.c < k.o && k.c < sZT &&
      tpS < k.c && !Number.isNaN(slS) && rewOkS;

    if (longSig || shortSig) {
      dir = longSig ? 1 : -1;
      ent = k.c;
      sl = longSig ? slL : slS;
      tp = longSig ? tpL : tpS;
      held = 0;
      entryIdx = i;
    }
    lAct = lAct && !longSig && k.l >= lSL && k.h <= lSH && lAge <= maxAge;
    sAct = sAct && !shortSig && k.h <= sHi && k.l >= sLo && sAge <= maxAge;
  }

  return { cfg, trades, open: dir !== 0 ? { dir, entry: ent, sl, tp, i: entryIdx } : null };
      }
