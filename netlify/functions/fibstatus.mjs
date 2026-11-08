import { runTick, statusText } from "../../lib/fibswing.mjs";

// Shows the swing paper account as plain text.
// Add ?run=1 to also run one tick right now (safe: each setup is only handled once).
const text = (body, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export default async (req) => {
  const q = new URL(req.url).searchParams;
  try {
    let head = "";
    if (q.get("run") === "1") head = (await runTick()).join("\n") + "\n\n";
    return text(head + (await statusText()));
  } catch (e) {
    return text("Error: " + e.message, 500);
  }
};
