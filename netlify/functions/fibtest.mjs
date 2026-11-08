import { fibTrades } from "../../lib/fib.mjs";
import { TFS, PAPER, marketOpen } from "../../lib/paper.mjs";

const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const day = (t) => new Date(t).toISOString().slice(0, 10);
const stamp = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const sgn = (x, d = 1) => (x >= 0 ? "+" : "") + x.toFixed(d);

// Plain trend baseline: Donchian breakout, enter on a close beyond the N-bar channel,
// exit on a close beyond the opposite M-bar channel.
function donchian(c, N, M) {
  const trades = [];
  let dir = 0, ent = 0, ei = -1;
  for (let i = Math.max(N, M); i < c.length; i++) {
    const k = c[i];
    let hiN = -Infinity, loN = Infinity, hiM = -Infinity, loM = Infinity;
    for (let j = 1; j <= N; j++) {
      hiN = Math.max(hiN, c[i - j].h);
      loN = Math.min(loN, c[i - j].l);
    }
    for (let j = 1; j <= M; j++) {
      hiM = Math.max(hiM, c[i - j].h);
      loM = Math.min(loM, c[i - j].l);
    }
    if ((dir === 1 && k.c < loM) || (dir === -1 && k.c > hiM)) {
      trades.push({ i: ei, j: i, dir, entry: ent, exit: k.c, pips: ((k.c - ent) * dir) / 0.1, held: i - ei });
      dir = 0;
    }
    if (dir === 0) {
      if (k.c > hiN) { dir = 1; ent = k.c; ei = i; }
      else if (k.c < loN) { dir = -1; ent = k.c; ei = i; }
    }
  }
  return trades;
}

function summarize(trades, lo, hi, lot, tfMs) {
  const sel = trades.filter((t) => t.i >= lo && t.i < hi);
  const spreadPips = PAPER.spread / 0.1;
  let wins = 0, pips = 0, usd = 0, hold = 0, cum = 0, peak = 0, worst = 0;
  for (const t of sel) {
    const p = t.pips - spreadPips;
    const d = p * 0.1 * lot * PAPER.valuePerLot;
    pips += p;
    usd += d;
    hold += t.held;
    if (p > 0) wins++;
    cum += d;
    peak = Math.max(peak, cum);
    worst = Math.max(worst, peak - cum);
  }
  const n = sel.length;
  return {
    n,
    win: n ? Math.round((wins * 100) / n) : 0,
    usd,
    pips,
    hours: n ? (hold * tfMs) / n / 3600000 : 0,
    worst,
  };
}

function row(label, s) {
  return (
    `  ${label.padEnd(4)} n ${String(s.n).padStart(3)}  win ${String(s.win).padStart(2)}%  ` +
    `$ ${sgn(s.usd).padStart(6)}  pips ${sgn(s.pips, 0).padStart(6)}  ` +
    `hold ${s.hours.toFixed(1)}h  dip ${s.worst.toFixed(1)}`
  );
}

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const tf = q.get("tf") || "1h";
  if (!TFS[tf]) return text("tf must be one of: " + Object.keys(TFS).join(", "), 400);
  const apiKey = process.env.TWELVE_API_KEY;
  if (!apiKey) return text("Missing TWELVE_API_KEY in Netlify environment variables", 500);

  const lot = Number(q.get("lot")) || 0.1;
  const cfg = {};
  if (q.get("tp")) cfg.tpExt = Number(q.get("tp"));
  if (q.get("sl")) cfg.slATR = Number(q.get("sl"));
  if (q.get("len")) cfg.len = Number(q.get("len"));
  if (q.get("fri")) cfg.useFri = q.get("fri") === "1";
  if (q.get("ema")) cfg.useTrend = q.get("ema") === "1";

  const api =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD" +
    `&interval=${tf}&outputsize=5000&order=asc&timezone=UTC&apikey=${apiKey}`;
  let json;
  try {
    json = await (await fetch(api)).json();
  } catch (e) {
    return text("Could not reach the data provider: " + e.message, 502);
  }
  if (json.status === "error" || !Array.isArray(json.values)) {
    return text("Data error: " + String(json.message || JSON.stringify(json)).slice(0, 300), 502);
  }

  const now = Date.now();
  const ms = TFS[tf];
  const candles = json.values
    .map((v) => ({
      t: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      o: +v.open,
      h: +v.high,
      l: +v.low,
      c: +v.close,
    }))
    .filter((k) => k.t + ms <= now)
    .filter((k) => marketOpen(k.t) && k.h - k.l >= 0.05);

  const WARM = 250;
  if (candles.length < WARM + 200) return text("Not enough candles: " + candles.length);

  const fib = fibTrades(candles, cfg, ms);
  const don = donchian(candles, 20, 10);
  const mid = Math.floor((WARM + candles.length) / 2);
  const end = candles.length;

  const L = [];
  L.push(`FIB ZONE v5.1 vs TREND BASELINE | XAU/USD ${tf} | ${lot} lot, spread $${PAPER.spread}`);
  L.push(`A = older ${day(candles[WARM].t)} to ${day(candles[mid].t)}`);
  L.push(`B = newer ${day(candles[mid].t)} to ${day(candles[end - 1].t)}`);
  const c = fib.cfg;
  L.push(
    `Fib: target ${c.tpExt}, stop ${c.slATR} ATR, pivot ${c.len}, Friday cutoff ${c.useFri ? "on" : "off"}, trend filter ${c.useTrend ? "on" : "off"}`
  );
  L.push("Stops that gap past the level fill at the open. Finished trades only.");
  L.push("");
  L.push("FIB ZONE");
  L.push(row("A", summarize(fib.trades, WARM, mid, lot, ms)));
  L.push(row("B", summarize(fib.trades, mid, end, lot, ms)));
  L.push(row("All", summarize(fib.trades, WARM, end, lot, ms)));
  L.push("");
  L.push("TREND BASELINE (Donchian 20 in, 10 out)");
  L.push(row("A", summarize(don, WARM, mid, lot, ms)));
  L.push(row("B", summarize(don, mid, end, lot, ms)));
  L.push(row("All", summarize(don, WARM, end, lot, ms)));
  L.push("");
  L.push("Last 6 fib trades, to compare with your chart (time = candle open, UTC):");
  for (const t of fib.trades.filter((x) => x.i >= WARM).slice(-6).reverse()) {
    L.push(
      `  ${t.dir === 1 ? "BUY " : "SELL"} ${stamp(candles[t.i].t)} @ ${t.entry.toFixed(2)} ` +
        `SL ${t.sl.toFixed(2)} TP ${t.tp.toFixed(2)} -> ${t.why.toUpperCase()}`
    );
  }
  if (fib.open) {
    const o = fib.open;
    L.push(
      `  OPEN ${o.dir === 1 ? "BUY " : "SELL"} ${stamp(candles[o.i].t)} @ ${o.entry.toFixed(2)} SL ${o.sl.toFixed(2)} TP ${o.tp.toFixed(2)}`
    );
  }
  L.push("");
  L.push("Your settings were tuned on this history, so judge B more than A.");
  return text(L.join("\n"));
};
