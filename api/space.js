// /api/space — 로그인 없는 '우리집 코드' 공유 저장소(Upstash KV).
// 코드별로 { saved, cart, rev, at } 를 저장. 클라이언트가 병합 후 push/pull.
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 헷갈리는 글자(O,0,I,1,L) 제외
const SPACE_TTL_S = 7776000; // 90일(활동 시 push마다 갱신)

async function kvGet(key) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return null;
  try {
    const r = await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["GET", key]) });
    const j = await r.json();
    return j && j.result ? JSON.parse(j.result) : null;
  } catch { return null; }
}
async function kvSet(key, val) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return;
  try {
    await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["SET", key, JSON.stringify(val), "EX", SPACE_TTL_S]) });
  } catch {}
}
function genCode() { let s = ""; for (let i = 0; i < 6; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
async function readBody(req) {
  if (req.body) { try { return typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body; } catch { return {}; } }
  return await new Promise(resolve => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } }); });
}
// 저장함/장보기 용량 제한(악용 방지)
function trim(arr, n) { return Array.isArray(arr) ? arr.slice(0, n) : []; }

export default async function handler(req, res) {
  if (!(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) || !(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)) {
    return res.status(500).json({ error: "공유 기능은 서버 저장소(Upstash)가 필요해요. Vercel 환경변수(UPSTASH_REDIS_REST_URL/TOKEN)를 설정하세요." });
  }
  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const code = (url.searchParams.get("code") || "").toUpperCase().trim();
      if (!code) return res.status(400).json({ error: "code가 필요합니다." });
      const data = await kvGet("space:" + code);
      if (!data) return res.status(404).json({ error: "코드를 찾을 수 없어요." });
      return res.status(200).json(data);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const action = body.action;
      if (action === "create") {
        let code, tries = 0;
        do { code = genCode(); tries++; } while ((await kvGet("space:" + code)) && tries < 6);
        const data = { saved: [], cart: [], rev: 1, at: Date.now() };
        await kvSet("space:" + code, data);
        return res.status(200).json({ code, ...data });
      }
      if (action === "push") {
        const code = (body.code || "").toUpperCase().trim();
        if (!code) return res.status(400).json({ error: "code가 필요합니다." });
        const cur = await kvGet("space:" + code);
        if (!cur) return res.status(404).json({ error: "코드를 찾을 수 없어요." });
        const data = { saved: trim(body.saved, 500), cart: trim(body.cart, 300), rev: (cur.rev || 0) + 1, at: Date.now() };
        await kvSet("space:" + code, data);
        return res.status(200).json({ rev: data.rev, at: data.at });
      }
      return res.status(400).json({ error: "알 수 없는 action" });
    }
    return res.status(405).json({ error: "허용되지 않은 메서드" });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류: " + (e?.message || String(e)) });
  }
}
