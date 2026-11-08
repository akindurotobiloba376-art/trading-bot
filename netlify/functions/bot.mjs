import { analyze } from "../../lib/lrut.mjs";
import {
  CHART_CFG,
  TFS,
  MODES,
  DEFAULT_CONTROL,
  newAccount,
  step,
  flatten,
  marketOpen,
} from "../../lib/paper.mjs";

const url = (path) =>
  `${process.env.FIREBASE_DB_URL}/b/${process.env.BOT_KEY}${path}.json`;

async function get(path) {
  const res = await fetch(url(path));
  if (!res.ok) throw new Error("Firebase read failed " + res.status);
  return res.json();
}

async function put(path, value) {
  const res = await fetch(url(path), { method: "PUT", body: JSON.stringify(value) });
  if (!res.ok) throw new Error("Firebase write failed " + res.status);
}

// closed candles only, weekend and flat candles removed (same as the checker page)
async function load(tf, now) {
  const api =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD" +
    `&interval=${tf}&outputsize=600&order=asc&timezone=UTC&apikey=${process.env.TWELVE_API_KEY}`;
  const j = await (await fetch(api)).json();
  if (j.status === "error" || !Array.isArray(j.values)) {
    throw new Error(String(j.message || "bad response").slice(0, 120));
  }
  const ms = TFS[tf];
  return j.values
    .map((v) => ({
      t: Date.parse(v.datetime.replace(" ", "T") + "Z"),
      o: +v.open,
      h: +v.high,
      l: +v.low,
      c: +v.close,
    }))
    .filter((k) => k.t + ms <= now)
    .filter((k) => marketOpen(k.t) && k.h - k.l >= 0.05);
}

export default async () => {
  const need = ["FIREBASE_DB_URL", "BOT_KEY", "TWELVE_API_KEY"];
  const missing = need.filter((n) => !process.env[n]);
  if (missing.length) {
    console.log("Missing environment variables: " + missing.join(", "));
    return;
  }

  const now = Date.now();
  const iso = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

  let control = await get("/control");
  if (!control) {
    control = DEFAULT_CONTROL;
    await put("/control", control);
  }
  control = { ...DEFAULT_CONTROL, ...control, tf: { ...DEFAULT_CONTROL.tf, ...(control.tf || {}) } };

  const state = (await get("/state")) || {};
  state.lastT = state.lastT || {};
  state.checked = state.checked || {};
  state.acc = state.acc || {};
  let log = Array.isArray(state.log) ? state.log : Object.values(state.log || {});
  const say = (msg) => log.push(`${iso(now)} ${msg}`);

  const open = marketOpen(now);
  const jobs = [];

  for (const tf of Object.keys(TFS)) {
    const ms = TFS[tf];
    const due = Math.floor(now / ms) * ms - ms; // open time of the latest closed candle
    for (const m of MODES) {
      const key = `${tf}_${m}`;
      if (!state.acc[key]) state.acc[key] = newAccount(control.startBalance);
    }

    const enabled = control.tf[tf] && !control.killed;
    if (!enabled) {
      // switched off or kill switch: close open paper trades and skip candles meanwhile
      for (const m of MODES) {
        const a = state.acc[`${tf}_${m}`];
        if (a.open) {
          flatten(a, a.last, now, "off");
          say(`${tf} ${m} closed (${control.killed ? "kill switch" : "timeframe off"})`);
        }
      }
      state.lastT[tf] = due;
      state.checked[tf] = due;
      continue;
    }
    if (!open) continue; // market closed
    if ((state.checked[tf] || 0) >= due) continue; // already handled this candle
    jobs.push({ tf, ms, due });
  }

  const results = await Promise.all(
    jobs.map(async (j) => {
      try {
        return { ...j, candles: await load(j.tf, now) };
      } catch (e) {
        return { ...j, err: e.message };
      }
    })
  );

  for (const r of results) {
    if (r.err) {
      say(`${r.tf} data error: ${r.err}`);
      continue;
    }
    const c = r.candles;
    const last = c[c.length - 1];
    if (!last || last.t < r.due - 2 * r.ms) {
      say(`${r.tf} stale or empty data, skipped`);
      continue;
    }
    state.checked[r.tf] = r.due;

    const prev = state.lastT[r.tf];
    if (prev == null) {
      state.lastT[r.tf] = last.t;
      say(`${r.tf} started from candle ${iso(last.t)}`);
      continue;
    }

    const res = analyze(c, CHART_CFG);
    const sigAt = new Map(res.signals.map((s) => [s.t, s.kind.startsWith("Buy") ? 1 : -1]));

    for (const k of c) {
      if (k.t <= prev) continue;
      const dir = sigAt.get(k.t);
      if (dir) say(`${r.tf} ${dir === 1 ? "BUY" : "SELL"} signal @ ${k.c.toFixed(2)}`);
      for (const m of MODES) step(state.acc[`${r.tf}_${m}`], k, dir, m, control);
    }
    state.lastT[r.tf] = last.t;
  }

  state.beat = now;
  state.log = log.slice(-60);
  await put("/state", state);
};

export const config = { schedule: "*/5 * * * *" };
