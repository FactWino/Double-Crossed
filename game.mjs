// KleptoCross: tiny game server. Keeps one record per game and hands it to both phones.
import { store as getStore, getVapid, validSub } from "../shared/push.mjs";

const CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no look-alike characters
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function makeCode() {
  let c = "";
  for (let i = 0; i < 5; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
}

// Basic shape check so nobody can store junk in a game.
function validState(s) {
  if (!s || typeof s !== "object") return false;
  if (!Array.isArray(s.L) || s.L.length !== 9) return false;
  for (const row of s.L) {
    if (!Array.isArray(row) || row.length !== 9) return false;
    for (const cell of row) {
      if (cell === null) continue;
      if (!cell || typeof cell.ch !== "string" || !/^[A-Z]$/.test(cell.ch)) return false;
      if (cell.o !== 0 && cell.o !== 1) return false;
    }
  }
  if (s.turn !== 0 && s.turn !== 1) return false;
  if (!Number.isInteger(s.left) || s.left < 0 || s.left > 3) return false;
  if (!Array.isArray(s.score) || s.score.length !== 2) return false;
  if (!s.score.every((n) => Number.isInteger(n) && Math.abs(n) < 100000)) return false;
  if (!Array.isArray(s.solved) || s.solved.length > 60) return false;
  if (!s.solved.every((n) => Number.isInteger(n) && n >= 0 && n < 100)) return false;
  if (typeof s.over !== "boolean") return false;
  if (s.msg !== undefined && (typeof s.msg !== "string" || s.msg.length > 300)) return false;
  return true;
}

// What a phone is allowed to see (never the secret tokens).
const cleanName = (n) => String(n || "").replace(/[\u0000-\u001f\u007f<>&"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 16);
const publicView = (g) => ({
  version: g.version,
  names: g.names || ["", ""],
  joined: !!(g.seats[0] && g.seats[1]),
  pz: g.pz,
  state: g.state,
});

export default async (req) => {
  const store = getStore("games");
  const chatStore = getStore("chat"), seenStore = getStore("seen"), pendingStore = getStore("pending"), subStore = getStore("subs");
  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      if (url.searchParams.get("vapid")) return json({ publicKey: (await getVapid(url.origin)).publicKey });
      const code = (url.searchParams.get("code") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return json({ error: "bad code" }, 400);
      const g = await store.get(code, { type: "json" });
      if (!g) return json({ error: "not found" }, 404);
      const tok = url.searchParams.get("token");
      const seat = tok ? g.seats.indexOf(tok) : -1;
      if (seat !== -1 && url.searchParams.get("ping")) await seenStore.set(code + ":" + seat, String(Date.now()));
      let chat;
      if (seat !== -1 && url.searchParams.has("since")) {
        const since = Number(url.searchParams.get("since")) || 0;
        const lists = await Promise.all([0, 1].map(async (sd) =>
          ((await chatStore.get(code + ":" + sd, { type: "json" })) || []).map((m) => ({ s: sd, t: m.t, at: m.at }))));
        chat = lists.flat().filter((m) => m.at > since).sort((a, b) => a.at - b.at);
      }
      return json({ ...publicView(g), ...(seat !== -1 ? { seat } : {}), ...(chat ? { chat } : {}) });
    }

    if (req.method !== "POST") return json({ error: "method" }, 405);
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "bad request" }, 400);

    if (body.action === "create") {
      if (!Number.isInteger(body.pz) || body.pz < 0 || body.pz > 999) return json({ error: "bad puzzle" }, 400);
      if (!validState(body.state)) return json({ error: "bad state" }, 400);
      let code = makeCode();
      for (let i = 0; i < 5 && (await store.get(code)); i++) code = makeCode();
      const token = crypto.randomUUID();
      const hostSeat = 0; // the inviter is always Player 1; Across/Down is chosen at random in the game itself
      const seats = [null, null]; seats[hostSeat] = token;
      const names = ["", ""]; names[hostSeat] = cleanName(body.name);
      const g = { version: 1, created: Date.now(), pz: body.pz, seats, names, state: body.state };
      await store.setJSON(code, g);
      await seenStore.set(code + ":" + hostSeat, String(Date.now()));
      return json({ code, token, seat: hostSeat, version: g.version });
    }

    const code = String(body.code || "").toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return json({ error: "bad code" }, 400);
    const g = await store.get(code, { type: "json" });
    if (!g) return json({ error: "not found" }, 404);

    if (body.action === "join") {
      if (g.seats[0] && g.seats[1]) return json({ error: "full" }, 409);
      const token = crypto.randomUUID();
      const seat = g.seats[0] ? 1 : 0;
      g.seats[seat] = token;
      g.names = g.names || ["", ""]; g.names[seat] = cleanName(body.name);
      await store.setJSON(code, g);
      await seenStore.set(code + ":" + seat, String(Date.now()));
      return json({ token, seat, ...publicView(g) });
    }

    if (body.action === "push") {
      const seat = g.seats.indexOf(body.token);
      if (seat === -1 || !body.token) return json({ error: "not a player" }, 403);
      if (g.state.turn !== seat) return json({ error: "not your turn" }, 403);
      if (g.state.over) return json({ error: "game over" }, 409);
      if (body.version !== g.version) return json({ error: "out of date" }, 409);
      if (!validState(body.state)) return json({ error: "bad state" }, 400);
      const turnPassed = body.state.turn !== g.state.turn;
      g.state = body.state;
      g.version += 1;
      await store.setJSON(code, g);
      await seenStore.set(code + ":" + seat, String(Date.now()));
      // The turn just moved to the other player: note it, so a quiet player can be alerted later.
      if (g.state.over) await pendingStore.delete(code);
      else if (turnPassed) await pendingStore.setJSON(code, { seat: g.state.turn, at: Date.now() });
      return json({ version: g.version });
    }

    if (body.action === "say") {
      const seat = body.token ? g.seats.indexOf(body.token) : -1;
      if (seat === -1) return json({ error: "not a player" }, 403);
      const text = String(body.text || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
      if (!text) return json({ error: "empty" }, 400);
      const key = code + ":" + seat;
      const list = (await chatStore.get(key, { type: "json" })) || [];
      const last = list[list.length - 1], now = Date.now();
      if (last && now - last.at < 700) return json({ error: "slow down" }, 429);
      const at = last && last.at >= now ? last.at + 1 : now;
      list.push({ t: text, at });
      if (list.length > 60) list.splice(0, list.length - 60); // keep the latest 60 per player
      await chatStore.setJSON(key, list);
      return json({ at });
    }

    if (body.action === "subscribe" || body.action === "unsubscribe") {
      const seat = body.token ? g.seats.indexOf(body.token) : -1;
      if (seat === -1) return json({ error: "not a player" }, 403);
      if (body.action === "unsubscribe") { await subStore.delete(code + ":" + seat); return json({ ok: true }); }
      if (!validSub(body.sub)) return json({ error: "bad subscription" }, 400);
      await subStore.setJSON(code + ":" + seat, { endpoint: body.sub.endpoint, keys: { p256dh: body.sub.keys.p256dh, auth: body.sub.keys.auth } });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: "server" }, 500);
  }
};

export const config = { path: "/api/game" };
