import { analyze } from "../../lib/lrut.mjs";

const TF_MS = {
  "5min": 5 * 60000,
  "15min": 15 * 60000,
  "30min": 30 * 60000,
  "1h": 60 * 60000,
};

const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const pct = (n, d) => (d > 0 ? ((n * 100) / d).toFixed(1) + "%" : "-");

// Gold is closed from Friday ~22:00 UTC to Sunday ~22:00 UTC. Data feeds fill that gap
// with flat candles that create fake signals. TradingView has no bars there, so drop them.
function marketOpen(t) {
  const d = new Date(t);
  const day = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return false;
  if (day === 5 && mins >= 22 * 60) return false;
  if (day === 0 && mins < 22 * 60) return false;
  return true;
}

export default async (req) => {
  const q = new URL(req.url).searchParams;
  const tf = q.get("tf") || "15min";
  if (!TF_MS[tf]) return text("tf must be one of: " + Object.keys(TF_MS).join(", "), 400);

  const apiKey = process.env.TWELVE_API_KEY;
  if (!apiKey) return text("Missing TWELVE_API_KEY in Netlify environment variables", 500);

  const nShow = Math.min(Number(q.get("n")) || 12, 40);

  // defaults = your TradingView chart settings (XAUUSD 15m); override in the address if needed
  const cfg = {
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
  if (q.get("kv")) cfg.keyValue = Number(q.get("kv"));
  if (q.get("atr")) cfg.atrPeriod = Number(q.get("atr"));
  if (q.get("ha")) cfg.useHA = q.get("ha") === "1";
  if (q.get("ll")) cfg.linregLen = Number(q.get("ll"));
  if (q.get("sm")) cfg.signalLen = Number(q.get("sm"));
  if (q.get("re")) cfg.allowCont = q.get("re") === "1";

  const url =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD" +
    `&interval=${tf}&outputsize=600&order=asc&timezone=UTC&apikey=${apiKey}`;

  let json;
  try {
    json = await (await fetch(url)).json();
  } catch (e) {
    return text("Could not reach the data provider: " + e.message, 502);
  }
  if (json.status === "error" || !Array.isArray(json.values)) {
    return text("Data error: " + String(json.message || JSON.stringify(json)).slice(0, 300), 502);
  }

  const now = Date.now();
  let candles = json.values
    .map((v) => ({
      t: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      o: +v.open,
      h: +v.high,
      l: +v.low,
      c: +v.close,
    }))
    // keep closed candles only, the bot never acts on the forming candle
    .filter((k) => k.t + TF_MS[tf] <= now);

  const rawCount = candles.length;
  const rawLast = candles[rawCount - 1];
  // drop weekend / market-closed candles and flat candles (range under 5 cents)
  candles = candles.filter((k) => marketOpen(k.t) && k.h - k.l >= 0.05);
  const dropped = rawCount - candles.length;

  const r = analyze(candles, cfg);
  const c = r.cfg;
  const s = r.stats;
  const last = candles[candles.length - 1];

  const lines = [];
  lines.push(`XAU/USD ${tf} | key ${c.keyValue}, ATR ${c.atrPeriod}, HA ${c.useHA ? "on" : "off"}, LinReg ${c.linregLen}, smooth ${c.signalLen}, re-entries ${c.allowCont ? "on" : "off"}`);
  lines.push(`TP ${c.tp1Pips}/${c.tp2Pips}/${c.tp3Pips} pips, SL ${c.slPips} pips`);
  lines.push(`Closed candles used: ${candles.length} (dropped ${dropped} weekend/flat)`);
  if (rawLast && !candles.includes(rawLast)) lines.push("Market looks CLOSED right now (latest candles are flat)");
  lines.push(`Last closed candle opened: ${fmt(last.t)} UTC / ${fmt(last.t + 3600000)} WAT`);
  lines.push("");
  lines.push(`Last ${nShow} signals (time = candle open):`);
  for (const g of r.signals.slice(-nShow).reverse()) {
    lines.push(
      `${g.kind.padEnd(5)} ${fmt(g.t)} UTC | ${fmt(g.t + 3600000)} WAT  @ ${g.price.toFixed(2)}`
    );
  }
  lines.push("");
  lines.push(`Finished trades: ${s.doneN}`);
  lines.push(`TP1 ${s.c1} (${pct(s.c1, s.doneN)})  TP2 ${s.c2} (${pct(s.c2, s.doneN)})  TP3 ${s.c3} (${pct(s.c3, s.doneN)})`);
  lines.push(`SL ${s.sl} (${pct(s.sl, s.doneN)})  Neither ${s.none} (${pct(s.none, s.doneN)})`);
  if (r.open) {
    lines.push("");
    lines.push(
      `Open trade: ${r.open.dir === 1 ? "BUY" : "SELL"} entry ${r.open.entry.toFixed(2)}, ` +
        `SL ${r.open.sl === null ? "void" : r.open.sl.toFixed(2)}, ` +
        `TP1 ${r.open.tp1.toFixed(2)}${r.open.h1 ? " hit" : ""}`
    );
  }
  return text(lines.join("\n"));
};
