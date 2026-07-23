// /api/stats?key=SECRET  ( /stats 로 리라이트 ). STATS_KEY 환경변수로 보호.
async function kvPipe(cmds) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return [];
  try { const r = await fetch(u.replace(/\/$/, "") + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(cmds) }); return await r.json(); } catch { return []; }
}
function lastDays(n) { const a = [], d = Date.now(); for (let i = 0; i < n; i++) a.push(new Date(d - i * 86400000).toISOString().slice(0, 10)); return a; }
function pageWrap(inner) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>레시피튜브 통계</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#1c1c1e;background:#fafafa}h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:2px solid #ff5722;padding-bottom:4px}table{width:100%;border-collapse:collapse;margin-top:8px}td,th{padding:7px 10px;border-bottom:1px solid #eee;text-align:left;font-size:14px}th{color:#888;font-weight:600}.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:700}.bar{height:10px;background:#ff5722;border-radius:5px;display:inline-block;vertical-align:middle}.muted{color:#888;font-size:13px}</style></head><body>${inner}</body></html>`;
}
export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.STATS_KEY;
  const given = new URL(req.url, "http://localhost").searchParams.get("key") || "";
  if (!key) return res.status(200).end(pageWrap("<h1>🔒 설정 필요</h1><p class='muted'>Vercel 환경변수 <b>STATS_KEY</b>를 설정한 뒤 <code>/stats?key=설정한값</code> 으로 접속하세요.</p>"));
  if (given !== key) return res.status(401).end(pageWrap("<h1>🔒 접근 키 필요</h1><p class='muted'>주소 끝에 <code>?key=...</code> 를 붙여주세요.</p>"));

  const events = ["open", "search", "recipe", "save", "cart", "coupang", "roulette", "share", "family", "refresh"];
  const labels = { open: "앱 열기(방문)", search: "검색", recipe: "레시피 열람", save: "저장", cart: "장보기 담기", coupang: "쿠팡 클릭", roulette: "룰렛", share: "공유", family: "우리집 공유", refresh: "다시 정리" };
  const langs = ["ko", "en", "es"], langLabel = { ko: "한국어", en: "English", es: "Español" };
  const days = lastDays(14);
  const cmds = [];
  events.forEach(e => cmds.push(["GET", "st:tot:" + e]));
  langs.forEach(l => cmds.push(["GET", "st:lang:" + l]));
  days.forEach(d => cmds.push(["SCARD", "st:dau:" + d]));
  days.forEach(d => cmds.push(["GET", "st:day:" + d + ":search"]));
  const raw = await kvPipe(cmds);
  const val = i => { const x = raw && raw[i] ? raw[i].result : 0; const n = Number(x); return isNaN(n) ? 0 : n; };
  let k = 0;
  const tot = {}; events.forEach(e => tot[e] = val(k++));
  const lc = {}; langs.forEach(l => lc[l] = val(k++));
  const dau = days.map(() => val(k++));
  const dsearch = days.map(() => val(k++));

  const totRows = events.map(e => `<tr><td>${labels[e]}</td><td class="n">${tot[e].toLocaleString()}</td></tr>`).join("");
  const langTot = langs.reduce((s, l) => s + lc[l], 0) || 1;
  const langRows = langs.map(l => `<tr><td>${langLabel[l]}</td><td class="n">${lc[l].toLocaleString()}</td><td style="width:40%"><span class="bar" style="width:${Math.round(lc[l] / langTot * 100)}%"></span></td></tr>`).join("");
  const maxDau = Math.max(1, ...dau);
  const dayRows = days.map((d, i) => `<tr><td>${d}</td><td class="n">${dau[i]}</td><td class="n">${dsearch[i]}</td><td style="width:35%"><span class="bar" style="width:${Math.round(dau[i] / maxDau * 100)}%"></span></td></tr>`).join("");

  return res.status(200).end(pageWrap(`<h1>🍳 레시피튜브 사용 통계</h1><p class="muted">익명 집계 · 쿠키 없음 · 최근 14일</p>
<h2>기능별 누적 사용</h2><table><tr><th>기능</th><th class="n">횟수</th></tr>${totRows}</table>
<h2>언어별 사용</h2><table><tr><th>언어</th><th class="n">이벤트</th><th></th></tr>${langRows}</table>
<h2>일별 활성 사용자(DAU) · 검색수</h2><table><tr><th>날짜</th><th class="n">활성자</th><th class="n">검색</th><th></th></tr>${dayRows}</table>`));
}
