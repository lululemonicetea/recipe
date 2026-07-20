// /api/search — 유튜브 검색 프록시. 유튜브 링크/영상ID면 그 영상 하나 반환.
// 검색 결과 캐싱(메모리 + Upstash KV)으로 유튜브 API 호출/할당량을 크게 절약.
// 할당량 초과 시에는 저장해둔 예전 결과(스테일)로 대체해 앱이 멈추지 않게 함.
const YT = "https://www.googleapis.com/youtube/v3";

const SEARCH_TTL_S = Number(process.env.SEARCH_CACHE_TTL || 21600); // 신선 캐시 6시간
const STALE_TTL_S = 604800;                                        // 비상(스테일) 캐시 7일
const SEARCH_TTL_MS = SEARCH_TTL_S * 1000;

const mem = new Map();
function memGet(k) { const e = mem.get(k); if (e && Date.now() - e.at < SEARCH_TTL_MS) return e.data; if (e) mem.delete(k); return null; }
function memSet(k, d) { mem.set(k, { at: Date.now(), data: d }); if (mem.size > 300) mem.delete(mem.keys().next().value); }

async function kvGet(key) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return null;
  try {
    const r = await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["GET", key]) });
    const j = await r.json();
    return j && j.result ? JSON.parse(j.result) : null;
  } catch { return null; }
}
async function kvSetEx(key, val, ttl) {
  const u = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!u || !t) return;
  try {
    await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["SET", key, JSON.stringify(val), "EX", ttl]) });
  } catch {}
}

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  const h = +(m?.[1] || 0), mi = +(m?.[2] || 0), s = +(m?.[3] || 0);
  const seconds = h * 3600 + mi * 60 + s;
  const text = h ? `${h}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${mi}:${String(s).padStart(2, "0")}`;
  return { seconds, text };
}
function performanceScore(v) {
  const views = Number(v.viewCount || 0), likes = Number(v.likeCount || 0);
  const ageDays = Math.max(1, (Date.now() - new Date(v.publishedAt).getTime()) / 86400000);
  return Math.log10(views + 1) + (views > 0 ? likes / views : 0) * 20 + 1 / Math.log10(ageDays + 10);
}
function extractVideoId(q) {
  const m = (q || "").match(/(?:youtu\.be\/|\/shorts\/|\/embed\/|[?&]v=)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  const t = (q || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  return null;
}
function mapVideo(v) {
  const dur = parseDuration(v.contentDetails?.duration);
  return {
    id: v.id,
    title: v.snippet?.title || "",
    channel: v.snippet?.channelTitle || "",
    publishedAt: v.snippet?.publishedAt,
    thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || "",
    description: (v.snippet?.description || "").slice(0, 400),
    viewCount: Number(v.statistics?.viewCount || 0),
    likeCount: Number(v.statistics?.likeCount || 0),
    durationText: dur.text,
    durationSeconds: dur.seconds,
    url: `https://www.youtube.com/watch?v=${v.id}`,
  };
}
function sortByOrder(items, order) {
  const arr = items.slice();
  if (order === "latest") arr.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  else if (order === "views") arr.sort((a, b) => b.viewCount - a.viewCount);
  else if (order === "relevance") { /* 유튜브 관련성 순서 유지 */ }
  else arr.sort((a, b) => performanceScore(b) - performanceScore(a));
  return arr;
}

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "YOUTUBE_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요." });

  const url = new URL(req.url, "http://localhost");
  const q = (url.searchParams.get("q") || "").trim();
  const order = url.searchParams.get("order") || "performance";
  const pageToken = url.searchParams.get("pageToken") || "";
  const LOC = { ko: { rc: "KR", rl: "ko", sfx: "레시피 만들기" }, en: { rc: "US", rl: "en", sfx: "recipe" }, es: { rc: "ES", rl: "es", sfx: "receta" } };
  const loc = LOC[(url.searchParams.get("lang") || "").toLowerCase()];
  const region = loc ? loc.rc : (process.env.REGION_CODE || "KR");
  const lang = loc ? loc.rl : (process.env.RELEVANCE_LANGUAGE || "ko");
  const sfx = loc ? loc.sfx : "레시피 만들기";
  if (!q) return res.status(400).json({ error: "검색어(q)가 필요합니다." });

  // 유튜브 링크/영상ID → 해당 영상 하나 (search.list 할당량 소모 없음)
  const vid = extractVideoId(q);
  if (vid) {
    try {
      const vp = new URLSearchParams({ key, part: "snippet,statistics,contentDetails", id: vid });
      const vRes = await fetch(`${YT}/videos?${vp}`);
      const vJson = await vRes.json();
      if (!vRes.ok) return res.status(vRes.status).json({ error: vJson?.error?.message || "영상 조회 실패" });
      const items = (vJson.items || []).map(mapVideo);
      return res.status(200).json({ items, nextPageToken: null, single: true });
    } catch (e) {
      return res.status(500).json({ error: "서버 오류: " + (e?.message || String(e)) });
    }
  }

  const searchQuery = /레시피|만들기|요리|recipe|receta/i.test(q) ? q : `${q} ${sfx}`;
  const ytOrder = order === "latest" ? "date" : order === "relevance" ? "relevance" : "viewCount";

  // 캐시 키: 유튜브 호출 시그니처(ytOrder) 기준 → 성과순/조회수순이 같은 캐시 공유
  const ck = `yts:v1:${ytOrder}:${region}:${lang}:${pageToken || "0"}:${q.toLowerCase()}`;
  const sk = "stale:" + ck;

  // 1) 캐시 확인 (메모리 → KV)
  let raw = memGet(ck);
  if (!raw) { raw = await kvGet(ck); if (raw) memSet(ck, raw); }
  if (raw) return res.status(200).json({ items: sortByOrder(raw.items, order), nextPageToken: raw.nextPageToken, cached: true });

  // 2) 캐시 미스 → 유튜브 호출
  try {
    const sp = new URLSearchParams({
      key, part: "snippet", q: searchQuery, type: "video", maxResults: "25",
      order: ytOrder, regionCode: region, relevanceLanguage: lang, videoEmbeddable: "true", safeSearch: "moderate",
    });
    if (pageToken) sp.set("pageToken", pageToken);
    const sRes = await fetch(`${YT}/search?${sp}`);
    const sJson = await sRes.json();
    if (!sRes.ok) {
      const reason = sJson?.error?.errors?.[0]?.reason || "";
      // 할당량/레이트 초과 → 저장해둔 예전 결과로 대체
      if (reason === "quotaExceeded" || reason === "rateLimitExceeded") {
        const stale = await kvGet(sk);
        if (stale) return res.status(200).json({ items: sortByOrder(stale.items, order), nextPageToken: stale.nextPageToken, cached: true, stale: true });
      }
      const msg = reason === "quotaExceeded"
        ? "오늘의 유튜브 검색 사용량(하루 약 100회)을 초과했어요. 저장된 결과가 없는 검색은 잠시 후 다시 시도해 주세요."
        : (sJson?.error?.message || "유튜브 검색에 실패했습니다.");
      return res.status(sRes.status).json({ error: msg });
    }
    const ids = (sJson.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (ids.length === 0) return res.status(200).json({ items: [], nextPageToken: null });

    const vp = new URLSearchParams({ key, part: "snippet,statistics,contentDetails", id: ids.join(",") });
    const vRes = await fetch(`${YT}/videos?${vp}`);
    const vJson = await vRes.json();
    if (!vRes.ok) return res.status(vRes.status).json({ error: vJson?.error?.message || "영상 정보 조회 실패" });

    const items = (vJson.items || []).map(mapVideo); // 관련성(유튜브) 순서 유지
    const payload = { items, nextPageToken: sJson.nextPageToken || null };
    memSet(ck, payload);
    await kvSetEx(ck, payload, SEARCH_TTL_S);
    await kvSetEx(sk, payload, STALE_TTL_S);

    return res.status(200).json({ items: sortByOrder(items, order), nextPageToken: payload.nextPageToken });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류: " + (e?.message || String(e)) });
  }
}
