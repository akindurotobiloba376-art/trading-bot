// LinReg Candles + UT Bot Trend (LRUT) - JavaScript port of the Pine script.
// Candle format: { t: openTimeMs, o, h, l, c }  (oldest first, closed candles only)

export const DEFAULTS = {
  linregLen: 11,
  signalLen: 11,
  smaSignal: true,
  useLinReg: true,
  keyValue: 1,
  atrPeriod: 10,
  useHA: false,
  allowCont: true,
  tp1Pips: 50,
  tp2Pips: 100,
  tp3Pips: 200,
  slPips: 200,
  pipSize: 0.1, // gold: 1 pip = 0.1 price units (same as the Pine script)
};

// Pine ta.atr = RMA of true range (first bar TR = high - low)
function atrSeries(c, len) {
  const n = c.length;
  const out = new Array(n).fill(NaN);
  let sum = 0;
  let rma = NaN;
  for (let i = 0; i < n; i++) {
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

// Pine ta.linreg(source, length, 0): value of the regression line at the current bar
function linregSeries(v, len) {
  const n = v.length;
  if (len === 1) return v.slice();
  const out = new Array(n).fill(NaN);
  const sx = (len * (len - 1)) / 2;
  const sxx = ((len - 1) * len * (2 * len - 1)) / 6;
  const den = len * sxx - sx * sx;
  for (let i = len - 1; i < n; i++) {
    let sy = 0;
    let sxy = 0;
    for (let j = 0; j < len; j++) {
      const y = v[i - len + 1 + j];
      sy += y;
      sxy += j * y;
    }
    const slope = (len * sxy - sx * sy) / den;
    const icpt = (sy - slope * sx) / len;
    out[i] = icpt + slope * (len - 1);
  }
  return out;
}

function smaSeries(v, len) {
  const n = v.length;
  const out = new Array(n).fill(NaN);
  for (let i = len - 1; i < n; i++) {
    let s = 0;
    for (let j = 0; j < len; j++) s += v[i - j];
    out[i] = s / len;
  }
  return out;
}

function emaSeries(v, len) {
  const out = new Array(v.length).fill(NaN);
  const a = 2 / (len + 1);
  let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    if (Number.isNaN(v[i])) continue;
    prev = Number.isNaN(prev) ? v[i] : a * v[i] + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

export function analyze(candles, userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const n = candles.length;
  const C = candles.map((k) => k.c);

  // LinReg close and signal line
  const bclose = cfg.useLinReg ? linregSeries(C, cfg.linregLen) : C;
  const sigLine = cfg.smaSignal
    ? smaSeries(bclose, cfg.signalLen)
    : emaSeries(bclose, cfg.signalLen);

  // UT Bot
  const atr = atrSeries(candles, cfg.atrPeriod);
  const src = candles.map((k) => (cfg.useHA ? (k.o + k.h + k.l + k.c) / 4 : k.c));
  const stop = new Array(n).fill(NaN);
  const pos = new Array(n).fill(0);
  const sigs = new Array(n).fill(null); // { buy, sell, kind }

  for (let i = 0; i < n; i++) {
    const nLoss = cfg.keyValue * atr[i];
    pos[i] = i > 0 ? pos[i - 1] : 0;
    if (Number.isNaN(nLoss)) continue;

    const ps = i > 0 && !Number.isNaN(stop[i - 1]) ? stop[i - 1] : 0;
    const s = src[i];
    const s1 = i > 0 ? src[i - 1] : NaN;

    let st;
    if (s > ps && s1 > ps) st = Math.max(ps, s - nLoss);
    else if (s < ps && s1 < ps) st = Math.min(ps, s + nLoss);
    else if (s > ps) st = s - nLoss;
    else st = s + nLoss;
    stop[i] = st;

    if (s1 < ps && s > ps) pos[i] = 1;
    else if (s1 > ps && s < ps) pos[i] = -1;

    const prevStop = i > 0 ? stop[i - 1] : NaN;
    const above = s > st && s1 <= prevStop; // crossover(src, stop)
    const below = st > s && prevStop <= s1; // crossover(stop, src)
    const utBuy = s > st && above;
    const utSell = s < st && below;

    const crUp = i > 0 && bclose[i] > sigLine[i] && bclose[i - 1] <= sigLine[i - 1];
    const crDn = i > 0 && bclose[i] < sigLine[i] && bclose[i - 1] >= sigLine[i - 1];
    const contBuy = cfg.allowCont && pos[i] === 1 && crUp && !utBuy;
    const contSell = cfg.allowCont && pos[i] === -1 && crDn && !utSell;

    const buy = utBuy || contBuy;
    const sell = utSell || contSell;
    if (buy || sell) {
      sigs[i] = {
        buy,
        kind: buy ? (utBuy ? "Buy" : "Buy+") : utSell ? "Sell" : "Sell+",
      };
    }
  }

  // Trade tracker - mirrors the Pine script so the stats match the chart table
  const tp1D = cfg.tp1Pips * cfg.pipSize;
  const tp2D = cfg.tp2Pips * cfg.pipSize;
  const tp3D = cfg.tp3Pips * cfg.pipSize;
  const slD = cfg.slPips * cfg.pipSize;

  let active = false;
  let dir = 0;
  let entry = NaN, tp1 = NaN, tp2 = NaN, tp3 = NaN, slLvl = NaN;
  let h1 = false, h2 = false, h3 = false;
  let total = 0, c1 = 0, c2 = 0, c3 = 0, sCnt = 0;
  const signals = [];

  for (let i = 0; i < n; i++) {
    const k = candles[i];
    const slTouched =
      active && !h1 && (dir === 1 ? k.l <= slLvl : k.h >= slLvl);
    const hit1 =
      active && !h1 && !slTouched && (dir === 1 ? k.h >= tp1 : k.l <= tp1);
    const hit2 =
      active && !h2 && !slTouched && (dir === 1 ? k.h >= tp2 : k.l <= tp2);
    const hit3 =
      active && !h3 && !slTouched && (dir === 1 ? k.h >= tp3 : k.l <= tp3);
    if (hit1) c1++;
    if (hit2) c2++;
    if (hit3) c3++;
    if (slTouched) sCnt++;

    const sg = sigs[i];
    if (sg) {
      dir = sg.buy ? 1 : -1;
      entry = k.c;
      tp1 = entry + dir * tp1D;
      tp2 = entry + dir * tp2D;
      tp3 = entry + dir * tp3D;
      slLvl = entry - dir * slD;
      h1 = h2 = h3 = false;
      active = true;
      total++;
      signals.push({ i, t: k.t, kind: sg.kind, price: entry });
    } else {
      h1 = h1 || hit1;
      h2 = h2 || hit2;
      h3 = h3 || hit3;
      active = active && !slTouched;
    }
  }

  const doneN = total - (active ? 1 : 0);
  return {
    cfg,
    signals,
    stats: { total, doneN, c1, c2, c3, sl: sCnt, none: doneN - c1 - sCnt },
    open: active
      ? { dir, entry, tp1, tp2, tp3, sl: h1 ? null : slLvl, h1, h2, h3 }
      : null,
  };
      }
