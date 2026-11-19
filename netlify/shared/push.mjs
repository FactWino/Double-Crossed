// Shared helpers for turn alerts (web push).
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const store = (name) => getStore({ name, consistency: "strong" });

// The server makes its own "sender ID" (VAPID key pair) the first time it's needed
// and keeps it, so there is nothing for you to set up by hand.
export async function getVapid(originHint) {
  const cfg = store("config");
  const existing = await cfg.get("vapid", { type: "json" });
  if (existing) return existing;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pj = publicKey.export({ format: "jwk" });
  const sj = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(pj.x, "base64url"), Buffer.from(pj.y, "base64url")]);
  const v = {
    publicKey: pub.toString("base64url"),
    privateKey: sj.d,
    subject: originHint || process.env.URL || "https://example.netlify.app",
  };
  await cfg.setJSON("vapid", v);
  return (await cfg.get("vapid", { type: "json" })) || v;
}

// Only accept alert addresses that belong to the real browser push services.
export const PUSH_HOST = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)\//i;

export function validSub(s) {
  return !!s && typeof s.endpoint === "string" && s.endpoint.length < 1000 && PUSH_HOST.test(s.endpoint) &&
    s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string" &&
    s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}
