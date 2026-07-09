// /api/search — 유튜브 검색 프록시(성과순). 유튜브 링크/영상ID면 그 영상 하나 반환.
const YT = "https://www.googleapis.com/youtube/v3";

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

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "YOUTUBE_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요." });

  const url = new URL(req.url, "http://localhost");
  const q = (url.searchParams.get("q") || "").trim();
  const order = url.searchParams.get("order") || "performance";
  const pageToken = url.searchParams.get("pageToken") || "";
  const region = process.env.REGION_CODE || "KR";
  const lang = process.env.RELEVANCE_LANGUAGE || "ko";
  if (!q) return res.status(400).json({ error: "검색어(q)가 필요합니다." });

  // 유튜브 링크/영상ID → 해당 영상 하나
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

  const searchQuery = /레시피|만들기|요리|recipe/i.test(q) ? q : `${q} 레시피 만들기`;
  const ytOrder = order === "latest" ? "date" : order === "relevance" ? "relevance" : "viewCount";

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
      const msg = reason === "quotaExceeded"
        ? "오늘의 유튜브 API 사용량(무료 10,000)을 초과했어요. 내일 다시 시도하거나 할당량을 늘려주세요."
        : (sJson?.error?.message || "유튜브 검색에 실패했습니다.");
      return res.status(sRes.status).json({ error: msg });
    }
    const ids = (sJson.items || []).map(i => i.id?.videoId).filter(Boolean);
    if (ids.length === 0) return res.status(200).json({ items: [], nextPageToken: null });

    const vp = new URLSearchParams({ key, part: "snippet,statistics,contentDetails", id: ids.join(",") });
    const vRes = await fetch(`${YT}/videos?${vp}`);
    const vJson = await vRes.json();
    if (!vRes.ok) return res.status(vRes.status).json({ error: vJson?.error?.message || "영상 정보 조회 실패" });

    let items = (vJson.items || []).map(mapVideo);
    items.forEach(v => { v._score = performanceScore(v); });
    if (order === "latest") items.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    else if (order === "views") items.sort((a, b) => b.viewCount - a.viewCount);
    else if (order === "relevance") { /* keep */ }
    else items.sort((a, b) => b._score - a._score);
    items.forEach(v => delete v._score);

    return res.status(200).json({ items, nextPageToken: sJson.nextPageToken || null });
  } catch (e) {
    return res.status(500).json({ error: "서버 오류: " + (e?.message || String(e)) });
  }
}
