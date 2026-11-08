const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

const iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

export default async () => {
  const base = `${process.env.FIREBASE_DB_URL}/b/${process.env.BOT_KEY}`;
  if (!process.env.FIREBASE_DB_URL || !process.env.BOT_KEY) {
    return text("Missing FIREBASE_DB_URL or BOT_KEY in Netlify environment variables", 500);
  }
  const [control, state] = await Promise.all([
    fetch(base + "/control.json").then((r) => r.json()),
    fetch(base + "/state.json").then((r) => r.json()),
  ]);
  if (!state) return text("No bot data yet. Wait for the first 5-minute run.");

  const L = [];
  L.push(`Last run: ${state.beat ? iso(state.beat) + " UTC" : "never"}`);
  L.push(`Kill switch: ${control && control.killed ? "ON (no trading)" : "off"} | risk ${control ? control.riskPct : "?"}%`);
  L.push("");
  const names = Object.keys(state.acc || {}).sort();
  for (const n of names) {
    const a = state.acc[n];
    const s = a.st || {};
    const wr = s.n ? ((s.win * 100) / s.n).toFixed(0) + "%" : "-";
    L.push(`${n}: $${a.balance.toFixed(2)} (peak $${a.peak.toFixed(2)})${a.halted ? " HALTED " + (a.why || "") : ""}`);
    L.push(`  trades ${s.n || 0}, wins ${wr}, net $${(s.pnl || 0).toFixed(2)}, TP1/2/3 ${s.h1 || 0}/${s.h2 || 0}/${s.h3 || 0}, SL ${s.sl || 0}, BE ${s.be || 0}`);
    if (a.open) {
      const o = a.open;
      L.push(`  OPEN ${o.dir === 1 ? "BUY" : "SELL"} ${o.entry} lot ${o.lot} | TP1 ${o.h1 ? "hit" : o.tp1}${o.sl != null ? " | SL " + o.sl : " | no SL"}`);
    }
  }
  const log = Array.isArray(state.log) ? state.log : Object.values(state.log || {});
  L.push("");
  L.push("Recent activity:");
  for (const line of log.slice(-12).reverse()) L.push(line);
  return text(L.join("\n"));
};
