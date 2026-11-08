import { analyze } from "../../lib/lrut.mjs";
import { CHART_CFG, MODES, TFS, PAPER, newAccount, step, marketOpen } from "../../lib/paper.mjs";

const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const day = (t) => new Date(t).toISOString().slice(0, 10);
const money = (x) => (x >= 0 ? "+" : "") + x.toFixed(1);

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const tf = q.get("tf") || "30min";
  if (!TFS[tf]) return text("tf must be one of: " + Object.keys(TFS).join(", "), 400);
  const apiKey = process.env.TWELVE_API_KEY;
  if (!apiKey) return text("Missing TWELVE_API_KEY in Netlify environment variables", 500);

  const lot = Number(q.get("lot")) || 0.1;
  const stops = (q.get("stops") || "50,80,100,150")
    .split(",")
    .map(Number)
    .filter((n) => n > 0)
    .slice(0, 6);

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

  const WARM = 100;
  if (candles.length < WARM + 200) return text("Not enough candles: " + candles.length);

  const res = analyze(candles, CHART_CFG);
  const sigAt = new Map(res.signals.map((s) => [s.t, s.kind.startsWith("Buy") ? 1 : -1]));

  const mid = Math.floor((WARM + candles.length) / 2);
  const L = [];
  L.push(`SWEEP XAU/USD ${tf} | ${lot} lot, spread $${PAPER.spread}`);
  L.push(`A = older half ${day(candles[WARM].t)} to ${day(candles[mid].t)}`);
  L.push(`B = newer half ${day(candles[mid].t)} to ${day(candles[candles.length - 1].t)}`);
  L.push("Net dollars per rule. Trust a stop only if A and B both look good.");
  L.push("");

  for (const pips of stops) {
    L.push(`STOP $${(pips * 0.1).toFixed(0)} (${pips} pips)`);
    for (const mode of MODES) {
      const a = newAccount(1000);
      const ctl = { killed: false, riskPct: 5, fixedLot: lot, noLimits: true, slPips: pips };
      let balMid = a.balance;
      let peak = a.balance;
      let worst = 0;
      for (let i = WARM; i < candles.length; i++) {
        if (i === mid) balMid = a.balance;
        step(a, candles[i], sigAt.get(candles[i].t), mode, ctl);
        peak = Math.max(peak, a.balance);
        worst = Math.max(worst, peak - a.balance);
      }
      const A = balMid - 1000;
      const B = a.balance - balMid;
      L.push(
        `  ${mode.padEnd(7)} A ${money(A).padStart(6)}  B ${money(B).padStart(6)}  all ${money(A + B).padStart(6)}  dip ${worst.toFixed(0)}  n ${a.st.n}`
      );
    }
    L.push("");
  }
  L.push("Your tuned settings favour the past, so judge B more than A.");
  return text(L.join("\n"));
};
