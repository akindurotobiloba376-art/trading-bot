// Swing (fib zone) paper account for XAU/USD 1h. No real money is ever touched here.
//
// Fully separate from the scalping bot:
//  - its own Firebase path (/fibswing), its own account, balance and kill switch
//  - its own schedule (see netlify/functions/fibtick.mjs)
//  - it imports nothing from paper.mjs, so changing scalper settings never changes it
//
// Needs these Netlify environment variables:
//  TWELVE_API_KEY    (same one fibtest uses)
//  FIREBASE_DB_URL   e.g. https://your-project-default-rtdb.firebaseio.com
//  FIREBASE_AUTH     optional: a database secret or token, only if your rules are locked

import { fibTrades } from "./fib.mjs";

const TF_MS = 60 * 60000;
const ROOT = "fibswing";

const SIM = {
  spread: 0.3, // dollars per ounce, charged once per trade (same as fibtest)
  valuePerLot: 1, // cent account: 1 lot = $1 per $1 gold move
  minLot: 0.01,
  maxLot: 1,
  lotStep: 0.01,
  maxDrawdownPct: 15, // no new trades once this far below the peak
};

const DEFAULT_CONTROL = {
  killed: false, // true = no new trades (an open trade still closes normally)
  riskPct: 5, // % of balance risked per trade
  startBalance: 50, // used only when the account is first created
  minRewUsd: 4, // skip setups with under $4 reward (set 0 for exact TradingView rules)
  minRR: 0,
};

const r2 = (x) => Math.round(x * 100) / 100;
const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const sgn = (x, d = 2) => (x >= 0 ? "+" : "") + x.toFixed(d);

// ---------- Firebase (REST) ----------
function fb() {
  const url = (process.env.FIREBASE_DB_URL || "").replace(/\/+$/, "");
  if (!url) throw new Error("Missing FIREBASE_DB_URL in Netlify environment variables");
  const auth = process.env.FIREBASE_AUTH ? "?auth=" + encodeURIComponent(process.env.FIREBASE_AUTH) : "";
  return { url, auth };
}
async function dbGet(path) {
  const { url, auth } = fb();
  const r = await fetch(`${url}/${path}.json${auth}`);
  if (!r.ok) throw new Error(`Firebase read ${path} failed (${r.status})`);
  return r.json();
}
async function dbPut(path, value) {
  const { url, auth } = fb();
  const r = await fetch(`${url}/${path}.json${auth}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`Firebase write ${path} failed (${r.status})`);
}

// ---------- candles (raw, like TradingView) ----------
async function getCandles() {
  const key = process.env.TWELVE_API_KEY;
  if (!key) throw new Error("Missing TWELVE_API_KEY in Netlify environment variables");
  const api =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD" +
    `&interval=1h&outputsize=5000&order=asc&timezone=UTC&apikey=${key}`;
  const json = await (await fetch(api)).json();
  if (json.status === "error" || !Array.isArray(json.values)) {
    throw new Error("Data error: " + String(json.message || JSON.stringify(json)).slice(0, 200));
  }
  const now = Date.now();
  return json.values
    .map((v) => ({
      t: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      o: +v.open,
      h: +v.high,
      l: +v.low,
      c: +v.close,
    }))
    .filter((k) => k.t + TF_MS <= now);
}

// ---------- paper account ----------
function lotFor(balance, riskPct, slDist) {
  const riskUsd = (balance * riskPct) / 100;
  let lot = riskUsd / (Math.max(slDist, 0.01) * SIM.valuePerLot);
  lot = Math.floor(lot / SIM.lotStep + 1e-9) * SIM.lotStep;
  return r2(Math.min(SIM.maxLot, Math.max(SIM.minLot, lot)));
}

function newAccount(balance, seen) {
  return {
    balance,
    peak: balance,
    seen, // entry-candle time of the last setup already handled
    open: null,
    closed: [],
    halted: false,
    why: "",
    st: { n: 0, win: 0, pnl: 0, tp: 0, sl: 0, sync: 0 },
  };
}

function settle(acct, tr, exit, why, endT, log) {
  const gross = (exit - tr.entry) * tr.dir * tr.lot * SIM.valuePerLot;
  const net = gross - tr.fee;
  acct.balance = r2(acct.balance + gross);
  acct.peak = Math.max(acct.peak, acct.balance);
  acct.st.n++;
  if (net > 0) acct.st.win++;
  acct.st.pnl = r2(acct.st.pnl + net);
  acct.st[why] = (acct.st[why] || 0) + 1;
  acct.closed.push({
    t: tr.t,
    end: endT,
    dir: tr.dir,
    entry: tr.entry,
    sl: tr.sl,
    tp: tr.tp,
    exit: r2(exit),
    lot: tr.lot,
    pnl: r2(net),
    why,
  });
  if (acct.closed.length > 200) acct.closed.splice(0, acct.closed.length - 200);
  acct.open = null;
  log.push(`CLOSED ${tr.dir === 1 ? "BUY" : "SELL"} ${stamp(tr.t)} by ${why.toUpperCase()} at ${r2(exit)}  pnl $${sgn(net)}`);
}

// One pass: re-run the fib engine on the latest candles and apply anything new to the account.
// Safe to run any number of times: each setup is keyed by its entry candle and handled once.
export async function runTick() {
  const [ctlRaw, acctRaw] = await Promise.all([dbGet(`${ROOT}/control`), dbGet(`${ROOT}/account`)]);
  const ctl = { ...DEFAULT_CONTROL, ...(ctlRaw || {}) };
  if (!ctlRaw) await dbPut(`${ROOT}/control`, ctl);

  const candles = await getCandles();
  if (candles.length < 450) throw new Error("Not enough candles: " + candles.length);
  const last = candles[candles.length - 1];

  const log = [];
  let acct = acctRaw;
  if (!acct) {
    // fresh start: only setups from the latest closed candle onward are taken
    acct = newAccount(Number(ctl.startBalance) || DEFAULT_CONTROL.startBalance, last.t - TF_MS);
    log.push(`New swing account started with $${acct.balance}`);
  }
  acct.closed = acct.closed || [];
  acct.st = { n: 0, win: 0, pnl: 0, tp: 0, sl: 0, sync: 0, ...(acct.st || {}) };
  acct.open = acct.open || null;

  const res = fibTrades(candles, { minRewUsd: Number(ctl.minRewUsd) || 0, minRR: Number(ctl.minRR) || 0 }, TF_MS);
  const events = res.trades
    .map((t) => ({ ...t, done: true }))
    .concat(res.open ? [{ ...res.open, done: false }] : [])
    .sort((a, b) => a.i - b.i);

  for (const e of events) {
    const t = candles[e.i].t;

    // the paper trade that is already open
    if (acct.open && acct.open.t === t) {
      if (e.done) settle(acct, acct.open, e.exit, e.why, candles[e.j].t, log);
      continue;
    }

    // a new setup we have not handled yet
    if (t <= acct.seen) continue;
    acct.seen = t;

    if (ctl.killed || acct.halted || acct.balance <= 0) {
      log.push(`SKIPPED ${e.dir === 1 ? "BUY" : "SELL"} ${stamp(t)} (${ctl.killed ? "kill switch" : "halted"})`);
      continue;
    }
    const lot = lotFor(acct.balance, Number(ctl.riskPct) || DEFAULT_CONTROL.riskPct, Math.abs(e.entry - e.sl));
    const fee = r2(SIM.spread * lot * SIM.valuePerLot);
    acct.balance = r2(acct.balance - fee);
    acct.open = { t, dir: e.dir, entry: r2(e.entry), sl: r2(e.sl), tp: r2(e.tp), lot, fee };
    log.push(`OPENED ${e.dir === 1 ? "BUY" : "SELL"} ${stamp(t)} @ ${acct.open.entry} SL ${acct.open.sl} TP ${acct.open.tp} lot ${lot}`);
    if (e.done) settle(acct, acct.open, e.exit, e.why, candles[e.j].t, log);
  }

  // the engine no longer knows our open trade (its data window moved): close it at the last price
  if (acct.open && !events.some((e) => candles[e.i].t === acct.open.t)) {
    settle(acct, acct.open, last.c, "sync", last.t, log);
  }

  acct.peak = Math.max(acct.peak, acct.balance);
  if (!acct.halted && acct.balance <= acct.peak * (1 - SIM.maxDrawdownPct / 100)) {
    acct.halted = true;
    acct.why = "max drawdown";
    log.push("HALTED: max drawdown reached, no new trades");
  }

  await dbPut(`${ROOT}/account`, acct);
  await dbPut(`${ROOT}/heartbeat`, { t: Date.now(), candle: last.t, price: last.c });
  if (!log.length) log.push(`No change. Last closed candle ${stamp(last.t)} at ${last.c}`);
  return log;
}

export async function statusText() {
  const [ctlRaw, acct, hb] = await Promise.all([
    dbGet(`${ROOT}/control`),
    dbGet(`${ROOT}/account`),
    dbGet(`${ROOT}/heartbeat`),
  ]);
  const ctl = { ...DEFAULT_CONTROL, ...(ctlRaw || {}) };
  if (!acct) return "Swing account not started yet. It is created on the first scheduled tick (or open fibstatus?run=1).";
  const st = { n: 0, win: 0, pnl: 0, tp: 0, sl: 0, sync: 0, ...(acct.st || {}) };
  const closed = acct.closed || [];
  const L = [];
  L.push("SWING (fib zone 1h) PAPER ACCOUNT, separate from the scalper");
  L.push(
    `balance $${acct.balance.toFixed(2)} | peak $${acct.peak.toFixed(2)} | ` +
      (ctl.killed ? "KILLED" : acct.halted ? "HALTED (" + acct.why + ")" : "running")
  );
  L.push(hb ? `last tick ${stamp(hb.t)} UTC | last candle ${stamp(hb.candle)} at ${hb.price}` : "no tick yet");
  if (acct.open) {
    const o = acct.open;
    L.push(`OPEN ${o.dir === 1 ? "BUY" : "SELL"} ${stamp(o.t)} @ ${o.entry} SL ${o.sl} TP ${o.tp} lot ${o.lot}`);
  } else {
    L.push("no open trade");
  }
  L.push(
    `closed ${st.n} | win ${st.n ? Math.round((st.win * 100) / st.n) : 0}% | ` +
      `pnl $${sgn(st.pnl)} | TP ${st.tp} SL ${st.sl}`
  );
  L.push("");
  L.push("Last 5 closed:");
  for (const c of closed.slice(-5).reverse()) {
    L.push(
      `  ${c.dir === 1 ? "BUY " : "SELL"} ${stamp(c.t)} @ ${c.entry} -> ${String(c.why).toUpperCase()} ` +
        `lot ${c.lot} pnl $${sgn(c.pnl)}`
    );
  }
  if (!closed.length) L.push("  none yet");
  L.push("");
  L.push(`control: risk ${ctl.riskPct}% | minRewUsd ${ctl.minRewUsd} | minRR ${ctl.minRR}`);
  return L.join("\n");
}
