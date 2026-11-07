export default async () => {
  const url = process.env.FIREBASE_DB_URL;
  const now = new Date().toISOString();
  await fetch(`${url}/bot/latest.json`, {
    method: "PUT",
    body: JSON.stringify(now),
  });
  await fetch(`${url}/bot/log.json`, {
    method: "POST",
    body: JSON.stringify(now),
  });
};

export const config = { schedule: "*/5 * * * *" };
