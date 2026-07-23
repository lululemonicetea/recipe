// /api/track — 익명(랜덤 기기ID) 사용 이벤트 집계. 쿠키 없음, 제3자 없음. Upstash 재사용.
const EVENTS = new Set(["open", "search", "recipe", "save", "cart", "coupang", "roulette", "share", "family", "refresh", "lang_set"]);
function today() { return new Date().toISOString().slice(0, 10); }
async function readBody(req) {
  if (req.body) { try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body; } catch { return {}; } }
  return await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });
}
async function kvPipe(cmds) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return null;
  try { await fetch(u.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(cmds) }); } catch {}
}
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  const body = await readBody(req);
  const e = String(body.e || "").slice(0, 20);
  const d = String(body.d || "anon").slice(0, 60);
  const lang = ["ko", "en", "es"].includes(body.lang) ? body.lang : "ko";
  if (!EVENTS.has(e)) return res.status(204).end();
  const day = today(), EX = 3888000; // 45일
  await kvPipe([
    ["INCR", "st:tot:" + e],
    ["INCR", "st:day:" + day + ":" + e], ["EXPIRE", "st:day:" + day + ":" + e, EX],
    ["INCR", "st:lang:" + lang],
    ["SADD", "st:dau:" + day, d], ["EXPIRE", "st:dau:" + day, EX],
    ["SADD", "st:days", day],
  ]);
  return res.status(204).end();
}
