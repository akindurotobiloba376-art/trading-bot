import { fibTrades } from "../../lib/fib.mjs";
import { TFS, PAPER, marketOpen } from "../../lib/paper.mjs";

// Tests the optional min-reward filters on the same history as fibtest.
// Ranked by the WEAKER of the two halves, so a combo only ranks high if it works in both.

const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const day = (t) => new Date(t).toISOString().slice(0, 10);
const sgn = (x, d = 0) => (x >= 0 ? "+" : "") + x.toFixed(d);

const REW = [0, 2, 4, 6, 8, 12]; // minimum reward in dollars
const RR = [0, 0.25, 0.5, 0.75, 1]; // minimum reward / risk

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const tf = q.get("tf") || "1h";
  if (!TFS[tf]) return text("tf must be one of: " + Object.keys(TFS).join(", "), 400);
  const apiKey = process.env.TWELVE_API_KEY;
  if (!apiKey) return text("Missing TWELVE_API_KEY in Netlify environment variables", 500);
  const keepFilter = q.get("filter") === "1"; // default is raw candles, like TradingView
  const top = Math.min(30, Number(q.get("top")) || 10);

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
    .filter((k) => !keepFilter || (marketOpen(k.t) && k.h - k.l >= 0.05));

  const WARM = 250;
  if (candles.length < WARM + 200) return text("Not enough candles: " + candles.length);
  const mid = Math.floor((WARM + candles.length) / 2);
  const end = candles.length;
  const spreadPips = PAPER.spread / 0.1;

  const stats = (trades, lo, hi) => {
    let n = 0, wins = 0, pips = 0;
    for (const t of trades) {
      if (t.i < lo || t.i >= hi) continue;
      const p = t.pips - spreadPips;
      n++;
      pips += p;
      if (p > 0) wins++;
    }
    return { n, wins, pips };
  };

  const rows = [];
  for (const rew of REW) {
    for (const rr of RR) {
      const fib = fibTrades(candles, { minRewUsd: rew, minRR: rr }, ms);
      const A = stats(fib.trades, WARM, mid);
      const B = stats(fib.trades, mid, end);
      const n = A.n + B.n;
      const pips = A.pips + B.pips;
      rows.push({
        rew,
        rr,
        n,
        win: n ? Math.round(((A.wins + B.wins) * 100) / n) : 0,
        avg: n ? pips / n : 0,
        A: A.pips,
        B: B.pips,
        weak: Math.min(A.pips, B.pips),
      });
    }
  }

  const line = (r) =>
    `  rew $${String(r.rew).padEnd(2)} rr ${r.rr.toFixed(2)} | n ${String(r.n).padStart(3)} ` +
    `win ${String(r.win).padStart(2)}% avg ${sgn(r.avg).padStart(4)} ` +
    `A ${sgn(r.A).padStart(5)} B ${sgn(r.B).padStart(5)}`;

  const base = rows.find((r) => r.rew === 0 && r.rr === 0);
  const ranked = rows
    .filter((r) => r.n >= 30 && !(r.rew === 0 && r.rr === 0))
    .sort((a, b) => b.weak - a.weak)
    .slice(0, top);

  const L = [];
  L.push(`FIB ZONE FILTER SWEEP | XAU/USD ${tf} | spread $${PAPER.spread} charged per trade`);
  L.push(`A = ${day(candles[WARM].t)} to ${day(candles[mid].t)}`);
  L.push(`B = ${day(candles[mid].t)} to ${day(candles[end - 1].t)}`);
  L.push(`Candles: ${candles.length} | filter ${keepFilter ? "on" : "off (raw)"}`);
  L.push("n = trades, win = wins after spread, avg = pips per trade after spread");
  L.push("A / B = total pips after spread in each half");
  L.push("");
  L.push("BASELINE (exact TradingView rules)");
  L.push(line(base));
  L.push("");
  L.push(`TOP ${ranked.length} BY WEAKER HALF (needs 30+ trades)`);
  for (const r of ranked) L.push(line(r));
  L.push("");
  L.push("Pick one that beats the baseline in BOTH A and B, and prefer a round, middle");
  L.push("value over the single best number. Every extra setting you tune adds overfit risk.");
  return text(L.join("\n"));
};
