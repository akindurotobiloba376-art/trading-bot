// Paper-trading rules for the LRUT bot. No real money is ever touched here.

// Your TradingView chart settings (XAUUSD)
export const CHART_CFG = {
  linregLen: 14,
  signalLen: 14,
  keyValue: 1.2,
  atrPeriod: 10,
  useHA: true,
  allowCont: false,
  tp1Pips: 30,
  tp2Pips: 60,
  tp3Pips: 100,
  slPips: 150,
};

// ASSUMPTIONS (change here if your broker differs)
export const PAPER = {
  spread: 0.3, // gold spread in dollars per ounce, charged once per trade
  valuePerLot: 1, // cent account like your USC ticket: 1 lot = $1 per $1 gold move
  minLot: 0.01,
  maxLot: 1,
  lotStep: 0.01,
  dailyLossPct: 10, // stop opening new trades for the day after losing this % of the day's start balance
  maxDrawdownPct: 15, // halt the account at this % below its peak
};

// void = your chart's rule: thirds at TP1/TP2/TP3, no stop after TP1.
// be = same thirds, stop moves to entry after TP1.
// ratchet = two halves: half closes at TP1 and the other half runs to TP3.
//           The stop moves to entry at TP1, then halfway between TP1 and TP2 at TP2.
export const MODES = ["void", "be", "ratchet"];
const WEIGHTS = {
  void: [1 / 3, 1 / 3, 1 / 3],
  be: [1 / 3, 1 / 3, 1 / 3],
  ratchet: [0.5, 0, 0.5],
};

export const TFS = {
  "5min": 5 * 60000,
  "15min": 15 * 60000,
  "30min": 30 * 60000,
  "1h": 60 * 60000,
};

export const DEFAULT_CONTROL = {
  killed: false,
  riskPct: 5,
  startBalance: 50,
  tf: { "5min": true, "15min": true, "30min": true, "1h": true },
};

const PIP = 0.1; // gold pip size, same as the Pine script
const r2 = (x) => Math.round(x * 100) / 100;

// Gold is closed from Friday ~22:00 UTC to Sunday ~22:00 UTC
export function marketOpen(t) {
  const d = new Date(t);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return false;
  if (day === 5 && mins >= 22 * 60) return false;
  if (day === 0 && mins < 22 * 60) return false;
  return true;
}

// trading day starts at 22:00 UTC
const dayKey = (t) => Math.floor((t - 22 * 3600000) / 86400000);

export function newAccount(balance) {
  return {
    balance,
    peak: balance,
    dayKey: 0,
    dayStart: balance,
    halted: false,
    why: "",
    last: 0,
    closed: [],
    st: { n: 0, win: 0, pnl: 0, h1: 0, h2: 0, h3: 0, sl: 0, be: 0, lock: 0, flip: 0, off: 0, done: 0 },
  };
}

export function lotFor(balance, riskPct, slDist) {
  const riskUsd = (balance * riskPct) / 100;
  let lot = riskUsd / (slDist * PAPER.valuePerLot);
  lot = Math.floor(lot / PAPER.lotStep + 1e-9) * PAPER.lotStep;
  return r2(Math.min(PAPER.maxLot, Math.max(PAPER.minLot, lot)));
}

function part(acct, tr, qty, price) {
  const pnl = (price - tr.entry) * tr.dir * qty * PAPER.valuePerLot;
  acct.balance += pnl;
  tr.pnl += pnl;
}

function finish(acct, tr, reason, t) {
  acct.st.n++;
  if (tr.pnl > 0) acct.st.win++;
  acct.st[reason] = (acct.st[reason] || 0) + 1;
  acct.st.pnl += tr.pnl;
  acct.closed.push({
    t: tr.t,
    end: t,
    dir: tr.dir,
    entry: tr.entry,
    lot: tr.lot,
    pnl: r2(tr.pnl),
    why: reason,
  });
  if (acct.closed.length > 40) acct.closed.splice(0, acct.closed.length - 40);
  acct.open = null;
}

// trades saved by the first version used "rem" (thirds left)
function legacy(tr) {
  if (tr.left === undefined) {
    tr.left = (tr.rem === undefined ? 3 : tr.rem) / 3;
    tr.w = WEIGHTS.void;
  }
}

function closeRest(acct, tr, price, reason, t) {
  legacy(tr);
  part(acct, tr, tr.left * tr.lot, price);
  tr.left = 0;
  finish(acct, tr, reason, t);
}

// Close any open trade at a price (kill switch, timeframe switched off)
export function flatten(acct, price, t, reason = "off") {
  if (acct.open) closeRest(acct, acct.open, price || acct.open.entry, reason, t);
}

// Apply one closed candle to a trade (stop is checked first, the safe assumption)
function manage(acct, k, mode) {
  const tr = acct.open;
  if (!tr) return;
  legacy(tr);
  const d = tr.dir;
  const hit = (lvl) => (d === 1 ? k.h >= lvl : k.l <= lvl);

  if (tr.sl != null && (d === 1 ? k.l <= tr.sl : k.h >= tr.sl)) {
    const why = !tr.h1 ? "sl" : mode === "ratchet" && tr.h2 ? "lock" : "be";
    closeRest(acct, tr, tr.sl, why, k.t);
    return;
  }
  if (!tr.h1 && hit(tr.tp1)) {
    part(acct, tr, tr.w[0] * tr.lot, tr.tp1);
    tr.left -= tr.w[0];
    tr.h1 = true;
    acct.st.h1++;
    tr.sl = mode === "void" ? null : tr.entry;
  }
  if (!tr.h2 && hit(tr.tp2)) {
    part(acct, tr, tr.w[1] * tr.lot, tr.tp2);
    tr.left -= tr.w[1];
    tr.h2 = true;
    acct.st.h2++;
    if (mode === "ratchet") tr.sl = r2((tr.tp1 + tr.tp2) / 2);
  }
  if (!tr.h3 && hit(tr.tp3)) {
    part(acct, tr, tr.w[2] * tr.lot, tr.tp3);
    tr.left -= tr.w[2];
    tr.h3 = true;
    acct.st.h3++;
  }
  if (tr.left <= 1e-9) finish(acct, tr, "done", k.t);
}

function openTrade(acct, k, dir, ctl, mode) {
  const slDist = CHART_CFG.slPips * PIP;
  const lot = ctl.fixedLot || lotFor(acct.balance, ctl.riskPct, slDist);
  const fee = PAPER.spread * lot * PAPER.valuePerLot;
  acct.balance -= fee;
  const e = r2(k.c);
  acct.open = {
    dir,
    entry: e,
    t: k.t,
    lot,
    fee: r2(fee),
    pnl: -fee,
    left: 1,
    w: WEIGHTS[mode],
    h1: false,
    h2: false,
    h3: false,
    tp1: r2(e + dir * CHART_CFG.tp1Pips * PIP),
    tp2: r2(e + dir * CHART_CFG.tp2Pips * PIP),
    tp3: r2(e + dir * CHART_CFG.tp3Pips * PIP),
    sl: r2(e - dir * slDist),
  };
}

// One closed candle for one account. sig = 1 (buy), -1 (sell) or undefined.
export function step(acct, k, sig, mode, ctl) {
  acct.last = k.c;
  const dk = dayKey(k.t);
  if (acct.dayKey !== dk) {
    acct.dayKey = dk;
    acct.dayStart = acct.balance;
  }

  manage(acct, k, mode);
  if (sig && acct.open) closeRest(acct, acct.open, k.c, "flip", k.t); // a new signal replaces the old trade

  acct.peak = Math.max(acct.peak, acct.balance);
  if (!ctl.noLimits && !acct.halted && acct.balance <= acct.peak * (1 - PAPER.maxDrawdownPct / 100)) {
    acct.halted = true;
    acct.why = "max drawdown";
    flatten(acct, k.c, k.t);
  }

  const dayLoss = acct.dayStart - acct.balance;
  const capHit = !ctl.noLimits && dayLoss >= (acct.dayStart * PAPER.dailyLossPct) / 100;
  if (sig && !acct.halted && !ctl.killed && !capHit && acct.balance > 0) {
    openTrade(acct, k, sig, ctl, mode);
  }
}
