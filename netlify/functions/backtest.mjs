import { analyze } from "../../lib/lrut.mjs";
import { CHART_CFG, MODES, TFS, PAPER, newAccount, step, marketOpen } from "../../lib/paper.mjs";

const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const day = (t) => new Date(t).toISOString().slice(0, 10);

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const tf = q.get("tf") || "15min";
  if (!TFS[tf]) return text("tf must be one of: " + Object.keys(TFS).join(", "), 400);
  const apiKey = process.env.TWELVE_API_KEY;
  if (!apiKey) return text("Missing TWELVE_API_KEY in Netlify environment variables", 500);

  const size = Math.min(Number(q.get("n")) || 5000, 5000);
  const lot = Number(q.get("lot")) || 0.1;

  const api =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD" +
    `&interval=${tf}&outputsize=${size}&order=asc&timezone=UTC&apikey=${apiKey}`;
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
  const candles = json.values
    .map((v) => ({
      t: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      o: +v.open,
      h: +v.high,
      l: +v.low,
      c: +v.close,
    }))
    .filter((k) => k.t + TFS[tf] <= now)
    .filter((k) => marketOpen(k.t) && k.h - k.l >= 0.05);

  const WARM = 100; // let the indicators settle before trading
  if (candles.length < WARM + 50) return text("Not enough candles: " + candles.length);

  const res = analyze(candles, CHART_CFG);
  const sigAt = new Map(res.signals.map((s) => [s.t, s.kind.startsWith("Buy") ? 1 : -1]));

  const first = candles[WARM];
  const last = candles[candles.length - 1];
  const days = Math.max(1, Math.round((last.t - first.t) / 86400000));

  const L = [];
  L.push(`BACKTEST XAU/USD ${tf} | ${day(first.t)} to ${day(last.t)} (${days} days, ${candles.length - WARM} candles)`);
  L.push(`Fixed ${lot} lot per trade, spread $${PAPER.spread}, chart settings, finished trades only`);
  L.push("");

  for (const mode of MODES) {
    const a = newAccount(1000);
    const ctl = { killed: false, riskPct: 5, fixedLot: lot, noLimits: true };
    let peak = a.balance;
    let worst = 0;
    for (let i = WARM; i < candles.length; i++) {
      step(a, candles[i], sigAt.get(candles[i].t), mode, ctl);
      peak = Math.max(peak, a.balance);
      worst = Math.max(worst, peak - a.balance);
    }
    const s = a.st;
    const wr = s.n ? ((s.win * 100) / s.n).toFixed(0) : "0";
    const avg = s.n ? (s.pnl / s.n).toFixed(2) : "0.00";
    L.push(`${mode.toUpperCase()}`);
    L.push(`  trades ${s.n} | wins ${wr}% | net $${s.pnl.toFixed(2)} | avg $${avg}/trade`);
    L.push(`  worst dip $${worst.toFixed(2)} | TP1/2/3 hit ${s.h1}/${s.h2}/${s.h3}`);
    L.push(`  ended by: stop ${s.sl}, breakeven ${s.be}, lock ${s.lock}, new signal ${s.flip}, all targets ${s.done}`);
    L.push("");
  }
  L.push("Note: your settings were tuned on this same history, so live results will be worse.");
  L.push("Compare the three rules with each other, not the dollar amounts with real life.");
  return text(L.join("\n"));
};
