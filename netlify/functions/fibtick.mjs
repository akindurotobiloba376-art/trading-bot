import { runTick } from "../../lib/fibswing.mjs";

// Swing (fib zone 1h) tick. Runs once an hour at minute 3, after the 1h candle has closed,
// and away from the scalper's 5-minute ticks (:00, :05, :10 ...) so they never overlap.
// Uses 1 Twelve Data request per run (24 a day).
export default async () => {
  try {
    const log = await runTick();
    console.log(log.join("\n"));
  } catch (e) {
    console.error("fibtick failed:", e.message);
  }
};

export const config = { schedule: "3 * * * *" };
