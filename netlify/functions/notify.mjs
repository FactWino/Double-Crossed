// Runs once a minute. Sends a "your turn" alert only when the player whose turn it is
// has been waiting a couple of minutes AND is not currently on the game page.
import webpush from "web-push";
import { store, getVapid } from "../shared/push.mjs";

const WAIT_MS = 2 * 60 * 1000;   // turn must have been waiting at least this long
const ACTIVE_MS = 75 * 1000;     // "on the page" = checked in within this long
const GIVE_UP_MS = 48 * 60 * 60 * 1000;

export default async () => {
  const pending = store("pending"), games = store("games"), subs = store("subs"), seen = store("seen");
  const { blobs } = await pending.list();
  if (!blobs.length) return;
  const v = await getVapid();
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
  const now = Date.now();
  for (const { key } of blobs) {
    try {
      const p = await pending.get(key, { type: "json" });
      if (!p) continue;
      if (now - p.at > GIVE_UP_MS) { await pending.delete(key); continue; }
      if (now - p.at < WAIT_MS) continue;
      const g = await games.get(key, { type: "json" });
      if (!g || g.state.over || g.state.turn !== p.seat) { await pending.delete(key); continue; }
      const last = Number(await seen.get(key + ":" + p.seat)) || 0;
      if (now - last < ACTIVE_MS) continue; // they're playing right now: no alert (check again next minute)
      const sub = await subs.get(key + ":" + p.seat, { type: "json" });
      if (!sub) { await pending.delete(key); continue; }
      const payload = JSON.stringify({
        title: "KleptoCross",
        body: "It’s your turn! Your friend has played.",
        url: "/?game=" + key + "&k=" + g.seats[p.seat],
        tag: key,
      });
      try {
        await webpush.sendNotification(sub, payload, { TTL: 6 * 60 * 60 });
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await subs.delete(key + ":" + p.seat);
      }
      await pending.delete(key); // one alert per turn
    } catch (e) { /* skip this game, try again next minute */ }
  }
};

export const config = { schedule: "* * * * *" };
