// /api/comments — 유튜브 댓글로 "맛보장" 신호를 계산(키워드 휴리스틱). 영상별 캐시.
// commentThreads.list = 1유닛/영상 (검색 100의 1/100).
const YT = "https://www.googleapis.com/youtube/v3";
const CSIG_TTL_S = 1209600; // 14일
const MEM_TTL_MS = 6 * 3600 * 1000;
const mem = new Map();

async function kvGet(key) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return null;
  try { const r = await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["GET", key]) }); const j = await r.json(); return j && j.result ? JSON.parse(j.result) : null; } catch { return null; }
}
async function kvSetEx(key, val, ttl) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return;
  try { await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["SET", key, JSON.stringify(val), "EX", ttl]) }); } catch {}
}

function scoreComments(items) {
  let s = 0, strong = 0, pos = 0, neg = 0, best = null, bestW = -1;
  for (const it of (items || [])) {
    const sn = it && it.snippet && it.snippet.topLevelComment && it.snippet.topLevelComment.snippet;
    if (!sn) continue;
    const t = (sn.textOriginal || sn.textDisplay || "").replace(/<[^>]+>/g, " ");
    const likes = Number(sn.likeCount || 0);
    const w = 1 + Math.log10(likes + 1);
    let cs = 0, isStrong = false, isNeg = false;
    if (/실패[^.!?]{0,10}(없|안|모르)/.test(t)) { cs += 2; isStrong = true; }
    else if (/실패(했|함|임|하고|한\s*적\s*있)|망(했|함)|폭망/.test(t)) { cs -= 2; isNeg = true; }
    if (/인생\s*(레시피|메뉴|맛)|인생레시피|황금\s*(레시피|비율)|존맛|jmt|꿀맛|또\s*(만들|해\s*먹|해먹)|맨날\s*(해\s*먹|해먹|이것|먹)|매일\s*해\s*먹|자주\s*해\s*먹|따라\s*하기?\s*만|따라만|그대로\s*따라|\d+\s*번째|몇\s*번째|대박|최고|강추|짱맛/i.test(t)) { cs += 2; isStrong = true; }
    if (/맛있|맛나|맛짱|굿맛|좋아요|좋았|훌륭|쉽게|간단|성공했|성공적|따라\s*했더니|감동|일품|반했/.test(t)) { cs += 1; }
    if (/싱거|너무\s*짜|짜요|짜졌|맛없|별로|이상해|느끼해|비려|안\s*됐|안\s*돼요|실망/.test(t)) { cs -= 2; isNeg = true; }
    if (isStrong) strong++;
    if (cs > 0) pos++;
    if (isNeg) neg++;
    s += cs * w;
    if (cs >= 2 && w > bestW && t.length <= 80) { best = t.trim(); bestW = w; }
  }
  let badge = null;
  if (strong >= 3 && s >= 6 && neg <= Math.max(2, strong / 2)) badge = "hit";
  else if (s >= 3 && pos >= 2) badge = "good";
  return { badge, score: Math.round(s), sample: best, count: (items || []).length };
}
function slim(sig) { return { badge: sig.badge || null, score: sig.score || 0, sample: sig.sample || null }; }

async function fetchUncached(key, id) {
  const sp = new URLSearchParams({ key, part: "snippet", videoId: id, order: "relevance", maxResults: "60", textFormat: "plainText" });
  let sig;
  try {
    const r = await fetch(`${YT}/commentThreads?${sp}`);
    if (!r.ok) { sig = { badge: null, off: true }; }        // 댓글 꺼짐/오류 → 신호 없음
    else { const j = await r.json(); sig = scoreComments(j.items || []); }
  } catch { sig = { badge: null }; }
  mem.set(id, { at: Date.now(), sig });
  await kvSetEx("csig:" + id, sig, CSIG_TTL_S);
  return sig;
}

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "YOUTUBE_API_KEY가 설정되지 않았습니다." });
  const url = new URL(req.url, "http://localhost");
  const ids = (url.searchParams.get("ids") || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 25);
  if (!ids.length) return res.status(400).json({ error: "ids가 필요합니다." });

  const signals = {};
  let fetched = 0; const MAXF = 15;
  for (const id of ids) {
    const m = mem.get(id);
    if (m && Date.now() - m.at < MEM_TTL_MS) { signals[id] = slim(m.sig); continue; }
    const kv = await kvGet("csig:" + id);
    if (kv) { mem.set(id, { at: Date.now(), sig: kv }); signals[id] = slim(kv); continue; }
    if (fetched >= MAXF) { signals[id] = { badge: null }; continue; }
    fetched++;
    signals[id] = slim(await fetchUncached(key, id));
  }
  return res.status(200).json({ signals });
}
