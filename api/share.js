// /api/share?v=VIDEO_ID  ( /r/:v 로 리라이트됨 )
// 카톡·메신저에 공유하면 커버(썸네일)+요리명이 미리보기로 뜨고, 사람이 열면 앱의 해당 레시피로 이동.
const YT = "https://www.googleapis.com/youtube/v3";
async function kvGet(key) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return null;
  try { const r = await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["GET", key]) }); const j = await r.json(); return j && j.result ? JSON.parse(j.result) : null; } catch { return null; }
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const v = (url.searchParams.get("v") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20);
  const host = req.headers.host || "recipe-blush-ten.vercel.app";
  const origin = "https://" + host;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!v) return res.status(200).end('<!doctype html><meta http-equiv="refresh" content="0; url=/">');

  const appUrl = "/?recipe=" + encodeURIComponent(v);
  const thumb = `https://i.ytimg.com/vi/${v}/hqdefault.jpg`;
  let dish = "", servings = "", total = "";
  for (const l of ["ko", "en", "es"]) { try { const s2 = await kvGet("sum:" + l + ":" + v); if (s2) { dish = s2.dish || dish; servings = s2.servings || servings; total = s2.totalTime || total; if (dish) break; } } catch {} }
  if (!dish && process.env.YOUTUBE_API_KEY) {
    try {
      const sp = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: "snippet", id: v });
      const j = await Promise.race([fetch(`${YT}/videos?${sp}`).then(r => r.json()), new Promise((_, rj) => setTimeout(() => rj(0), 3500))]);
      dish = j?.items?.[0]?.snippet?.title || "";
    } catch {}
  }
  const title = dish || "레시피튜브 레시피";
  const bits = []; if (servings) bits.push("👥 " + servings); if (total) bits.push("⏱ " + total);
  const desc = (bits.join(" · ") || "유튜브 요리 영상의 재료·조리법을 한눈에") + " · 레시피튜브";

  return res.status(200).end(`<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · 레시피튜브</title>
<meta property="og:type" content="article">
<meta property="og:site_name" content="레시피튜브">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(thumb)}">
<meta property="og:url" content="${esc(origin + "/r/" + v)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:image" content="${esc(thumb)}">
<link rel="canonical" href="${esc(origin + appUrl)}">
<meta http-equiv="refresh" content="0; url=${esc(appUrl)}">
<script>location.replace(${JSON.stringify(appUrl)})</script>
</head><body style="font-family:sans-serif;text-align:center;padding:48px 20px;color:#333">
<p>🍳 레시피튜브로 이동 중…</p><p><a href="${esc(appUrl)}" style="color:#ff5722">열리지 않으면 여기를 누르세요</a></p>
</body></html>`);
}
