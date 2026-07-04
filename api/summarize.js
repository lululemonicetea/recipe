// /api/summarize?videoId=...  —  영상 설명 + 자막을 모아 재료·조리법으로 구조화
// GEMINI_API_KEY 있으면 AI(무료 티어)로 깔끔히 요약, 없으면 설명글에서 규칙 기반 추출.

const YT = "https://www.googleapis.com/youtube/v3";
const cache = new Map(); // videoId -> { at, data }
const TTL = 1000 * 60 * 60 * 24; // 24h

// 자막 추출(외부 라이브러리 없이 유튜브 자막 트랙을 직접 파싱, 실패해도 무시)
async function getTranscript(videoId) {
  try {
    const ua = { "User-Agent": "Mozilla/5.0", "Accept-Language": "ko,en" };
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ko`, { headers: ua })).text();
    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) return "";
    const tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
    if (!tracks.length) return "";
    const pick = tracks.find(t => (t.languageCode || "").startsWith("ko"))
              || tracks.find(t => t.kind !== "asr") || tracks[0];
    const xml = await (await fetch(pick.baseUrl.replace(/\\u0026/g, "&"), { headers: ua })).text();
    return xml.replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, " ").trim().slice(0, 6000);
  } catch {
    return "";
  }
}

function buildPrompt(title, description, tags, transcript) {
  return `당신은 요리 레시피 정리 전문가입니다. 아래 유튜브 요리 영상의 제목/설명/태그/자막을 바탕으로
실제로 따라 할 수 있는 레시피를 정리하세요. 정보가 없으면 지어내지 말고 비워두세요.
반드시 아래 JSON 형식으로만, 한국어로 답하세요.

{
  "dish": "요리 이름",
  "servings": "몇 인분 (예: 2인분, 모르면 빈 문자열)",
  "totalTime": "예상 소요시간 (예: 약 30분, 모르면 빈 문자열)",
  "difficulty": "쉬움|보통|어려움 중 하나",
  "ingredients": [ { "item": "재료명", "amount": "분량(예: 200g, 1큰술)" } ],
  "steps": [ "1단계 설명", "2단계 설명" ],
  "tips": [ "유용한 팁" ]
}

[제목]
${title}

[영상 설명]
${(description || "").slice(0, 3000)}

[태그]
${tags || "(없음)"}

[자막(일부)]
${transcript || "(자막 없음)"}
`;
}

async function summarizeWithGemini(title, description, tags, transcript) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: buildPrompt(title, description, tags, transcript) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 2048 },
  };
  const r = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "Gemini 요청 실패");
  let text = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  text = text.trim().replace(/^```json\s*/i, "").replace(/```$/g, "").trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end >= 0) text = text.slice(start, end + 1);
  const data = JSON.parse(text);
  data.source = "ai";
  return data;
}

// 재료 한 줄을 이름/분량으로 분리
const UNIT = "g|kg|mg|ml|l|개|알|장|큰술|작은술|스푼|컵|줌|톨|쪽|봉지|봉|공기|모|캔|손|줄|마리|대|통|조각|단|뿌리|스틱|T|t";
function splitIngredient(line) {
  const parts = line.split(/[:：]|\s{2,}|\s-\s/);
  if (parts.length >= 2 && parts[0].trim()) {
    return { item: parts[0].trim(), amount: parts.slice(1).join(" ").trim() };
  }
  const re = new RegExp(`((?:\\d+[.,\\/]?\\d*\\s*(?:${UNIT}))|약간|적당량|조금|한\\s?줌)\\.?\\s*$`, "i");
  const m = line.match(re);
  if (m && line.slice(0, m.index).trim()) {
    return { item: line.slice(0, m.index).trim(), amount: m[1].trim() };
  }
  return { item: line, amount: "" };
}

// AI 키가 없을 때: 설명글에서 재료/순서 추출 (완벽하진 않지만 무료)
function summarizeFromText(title, description) {
  const lines = (description || "").split(/\r?\n/).map(l => l.trim());
  const ingredients = [];
  const steps = [];
  let mode = "";
  const amountRe = new RegExp(`\\d+[.,\\/]?\\d*\\s*(?:${UNIT})|약간|적당량|조금`, "i");

  for (const raw of lines) {
    const line = raw.replace(/^[-•*▶️▪️·◦‣\s]+/, "").trim();
    if (!line) continue;
    if (/재료|준비물/.test(line) && line.length < 20) { mode = "ing"; continue; }
    if (/^\[?\s*(만드는\s*법|조리법|조리|레시피|순서|과정|step|recipe)/i.test(line)) { mode = "step"; continue; }
    if (/구독|좋아요|알림|인스타|문의|협찬|타임라인|출연|촬영|편집|음악|자막\s*:|https?:\/\//i.test(line)) continue;

    if (mode === "ing") {
      if (amountRe.test(line) || line.length < 24) ingredients.push(splitIngredient(line));
      else mode = "";
    } else if (mode === "step") {
      if (line.length > 3) steps.push(line.replace(/^\d+[.)]\s*/, ""));
    }
  }
  if (ingredients.length === 0) {
    for (const raw of lines) {
      const line = raw.replace(/^[-•*▶️▪️·◦‣\s]+/, "").trim();
      if (amountRe.test(line) && line.length < 40 && !/https?:\/\//.test(line)) ingredients.push(splitIngredient(line));
    }
  }
  return {
    source: "text",
    dish: title,
    servings: "", totalTime: "", difficulty: "",
    ingredients: ingredients.slice(0, 40),
    steps: steps.slice(0, 30),
    tips: [],
  };
}

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "YOUTUBE_API_KEY가 설정되지 않았습니다." });

  const url = new URL(req.url, "http://localhost");
  const videoId = url.searchParams.get("videoId");
  if (!videoId) return res.status(400).json({ error: "videoId가 필요합니다." });

  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < TTL) return res.status(200).json(hit.data);

  try {
    const vp = new URLSearchParams({ key, part: "snippet", id: videoId });
    const vRes = await fetch(`${YT}/videos?${vp}`);
    const vJson = await vRes.json();
    const sn = vJson?.items?.[0]?.snippet;
    if (!sn) return res.status(404).json({ error: "영상을 찾을 수 없습니다." });

    const title = sn.title || "";
    const description = sn.description || "";
    const tags = (sn.tags || []).join(", ");

    let data;
    if (process.env.GEMINI_API_KEY) {
      try {
        const transcript = await getTranscript(videoId);
        data = await summarizeWithGemini(title, description, tags, transcript);
      } catch (e) {
        data = summarizeFromText(title, description);
        data.aiError = "AI 요약 실패로 설명글 기반으로 대체했습니다: " + (e?.message || "");
      }
    } else {
      data = summarizeFromText(title, description);
    }

    data.videoId = videoId;
    data.channel = sn.channelTitle || "";

    const noIng = !(data.ingredients || []).some(i => i && (i.item || i.amount));
    const noStep = !((data.steps || []).length);
    if (noIng && noStep && !data.note) {
      data.note = "이 영상은 자막·설명이 부족해 자동으로 정리할 재료·순서를 찾지 못했어요. ‘영상에서 보기’로 확인해 주세요.";
    }

    cache.set(videoId, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "요약 중 오류: " + (e?.message || String(e)) });
  }
}
