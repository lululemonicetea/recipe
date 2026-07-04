// /api/summarize?videoId=...  —  영상 설명 + 자막을 재료·조리법으로 구조화
const YT = "https://www.googleapis.com/youtube/v3";
const cache = new Map();
const TTL = 1000 * 60 * 60 * 24;

async function getTranscript(videoId) {
  try {
    const ua = { "User-Agent": "Mozilla/5.0", "Accept-Language": "ko,en" };
    const html = await (await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=ko`, { headers: ua })).text();
    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) return "";
    const tracks = JSON.parse(m[1].replace(/\\u0026/g, "&"));
    if (!tracks.length) return "";
    const pick = tracks.find(t => (t.languageCode || "").startsWith("ko")) || tracks.find(t => t.kind !== "asr") || tracks[0];
    const xml = await (await fetch(pick.baseUrl.replace(/\\u0026/g, "&"), { headers: ua })).text();
    return xml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, " ").trim().slice(0, 6000);
  } catch { return ""; }
}

function buildPrompt(title, description, tags, transcript) {
  return "당신은 요리 레시피 정리 전문가입니다. 아래 유튜브 요리 영상의 제목/설명/태그/자막을 바탕으로 "
    + "따라 할 수 있는 레시피를 정리하세요. 정보가 없으면 지어내지 말고 비워두세요. "
    + "ingredients에는 '재료'만(예: 대파 1대, 된장 2스푼) 넣고 조리 동작 문장은 넣지 마세요. "
    + "steps에는 조리 순서 문장만 넣으세요. 한국어로 답하세요.\n\n"
    + "[제목]\n" + title + "\n\n[영상 설명]\n" + (description || "").slice(0, 3000)
    + "\n\n[태그]\n" + (tags || "(없음)") + "\n\n[자막(일부)]\n" + (transcript || "(자막 없음)");
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    dish: { type: "STRING" }, servings: { type: "STRING" }, totalTime: { type: "STRING" }, difficulty: { type: "STRING" },
    ingredients: { type: "ARRAY", items: { type: "OBJECT", properties: { item: { type: "STRING" }, amount: { type: "STRING" } } } },
    steps: { type: "ARRAY", items: { type: "STRING" } },
    tips: { type: "ARRAY", items: { type: "STRING" } },
  },
};

const KOR_SYS = { parts: [{ text: "너는 한국어로만 답하는 요리 도우미다. dish, ingredients, steps, tips의 모든 값을 반드시 자연스러운 한국어로 작성한다. 어떤 경우에도 영어 문장으로 답하지 않는다." }] };

function safeJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  let t = s >= 0 && e >= 0 ? text.slice(s, e + 1) : text;
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, "$1")); } catch {}
  return JSON.parse(t.replace(/[ -]+/g, " ").replace(/,\s*([}\]])/g, "$1"));
}

async function geminiFetch(endpoint, body) {
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.ok) return j;
    const msg = (j && j.error && j.error.message) || "";
    const transient = r.status === 503 || r.status === 500 || /high demand|overloaded|UNAVAILABLE|try again|internal/i.test(msg);
    last = new Error(msg || ("Gemini " + r.status));
    if (!transient) throw last;
    await new Promise(res => setTimeout(res, 1200 * (i + 1)));
  }
  throw last;
}

async function summarizeWithGemini(title, description, tags, transcript) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = {
    systemInstruction: KOR_SYS, contents: [{ parts: [{ text: buildPrompt(title, description, tags, transcript) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2, maxOutputTokens: 4096 },
  };
  const j = await geminiFetch(endpoint, body);
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text).join("").trim();
  const data = safeJson(text.replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
  data.source = "ai";
  return data;
}

const UNIT = "g|kg|mg|ml|l|개|알|장|큰술|작은술|스푼|컵|줌|톨|쪽|봉지|봉|공기|모|캔|손|줄|마리|대|통|조각|단|뿌리|스틱|T|t";
function splitIngredient(line) {
  const parts = line.split(/[:：]|\s{2,}|\s-\s/);
  if (parts.length >= 2 && parts[0].trim()) return { item: parts[0].trim(), amount: parts.slice(1).join(" ").trim() };
  const re = new RegExp(`((?:\\d+[.,\\/]?\\d*\\s*(?:${UNIT})(?=\\s|$|[,)]))|약간|적당량|조금|한\\s?줌)\\.?\\s*$`, "i");
  const m = line.match(re);
  if (m && line.slice(0, m.index).trim()) return { item: line.slice(0, m.index).trim(), amount: m[1].trim() };
  return { item: line, amount: "" };
}

function summarizeFromText(title, description) {
  const lines = (description || "").split(/\r?\n/).map(l => l.trim());
  const ingredients = [], steps = [];
  let mode = "";
  const amountRe = new RegExp(`\\d+[.,\\/]?\\d*\\s*(?:${UNIT})(?=\\s|$|[,)])|약간|적당량|조금`, "i");
  const isStep = l => /^\d+\s*[.)]/.test(l);
  const isSentence = l => /[다요죠함까]\.?$/.test(l) || l.length > 20;
  const clean = l => l.replace(/^\d+\s*[.)]\s*/, "").trim();
  for (const raw of lines) {
    const line = raw.replace(/^[-•*▶️▪️·◦‣\s]+/, "").trim();
    if (!line) continue;
    if (/https?:\/\//.test(line) || /구독|좋아요|알림|인스타|문의|협찬|타임라인|출연|촬영|편집|음악/.test(line)) continue;
    if (/(재료|준비물)/.test(line) && line.length < 12) { mode = "ing"; continue; }
    if (/(만드는\s*법|조리법|조리|레시피|순서|과정|만들기|step|recipe)/i.test(line) && line.length < 14) { mode = "step"; continue; }
    if (isStep(line)) { steps.push(clean(line)); mode = "step"; continue; }
    if (mode === "ing") {
      if (!isSentence(line) && (amountRe.test(line) || line.length <= 14)) ingredients.push(splitIngredient(line));
      else if (line.length > 3) { steps.push(line); mode = "step"; }
    } else if (mode === "step") {
      if (line.length > 3) steps.push(line);
    }
  }
  if (ingredients.length === 0) {
    for (const raw of lines) {
      const line = raw.replace(/^[-•*▶️▪️·◦‣\s]+/, "").trim();
      if (isStep(line) || isSentence(line) || /https?:\/\//.test(line)) continue;
      if (amountRe.test(line) && line.length <= 18) ingredients.push(splitIngredient(line));
    }
  }
  return { source: "text", dish: title, servings: "", totalTime: "", difficulty: "",
    ingredients: ingredients.slice(0, 40), steps: steps.slice(0, 30), tips: [] };
}

function parseDurSec(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  return (+(m?.[1] || 0)) * 3600 + (+(m?.[2] || 0)) * 60 + (+(m?.[3] || 0));
}

async function summarizeWithGeminiVideo(videoId, durSec) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const parts = [
    { text: "이 요리 영상을 보고(화면 자막과 음성 모두 참고) 재료와 조리 순서를 정리하세요. 없으면 지어내지 말고 비워두세요. 한국어로 답하세요." },
    { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}`, mimeType: "video/*" } },
  ];
  if (durSec > 720) parts[1].videoMetadata = { startOffset: "0s", endOffset: "720s" };
  const body = { systemInstruction: KOR_SYS, contents: [{ parts }], generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2, maxOutputTokens: 4096 } };
  const j = await geminiFetch(endpoint, body);
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text).join("").trim();
  const data = safeJson(text.replace(/^```json\s*/i, "").replace(/```$/g, "").trim());
  data.source = "ai-video";
  return data;
}

const hasContent = d => (d.ingredients || []).some(i => i && (i.item || i.amount)) || (d.steps || []).length > 0;
const isFull = d => (d.ingredients || []).some(i => i && (i.item || i.amount)) && (d.steps || []).length > 0;

function cleanErr(e) {
  const m = e?.message || String(e);
  if (/high demand|overloaded|UNAVAILABLE|503|try again|internal/i.test(m)) return "AI 서버가 잠시 붐벼요. 조금 뒤 다시 시도해 주세요.";
  if (/quota|exceed|RESOURCE_EXHAUSTED|rate|429/i.test(m)) return "무료 AI 사용량이 잠시 초과됐어요. 1~2분 뒤 다시 시도해 주세요.";
  return "영상 분석 실패: " + m.slice(0, 120);
}

async function smartSummarize(videoId, title, description, tags, durSec) {
  const videoOn = process.env.GEMINI_VIDEO !== "0";
  const isShort = durSec > 0 && durSec <= 90;
  let vErr = "";
  if (isShort) {
    if (videoOn) {
      try { return await summarizeWithGeminiVideo(videoId, durSec); } catch (e) { vErr = cleanErr(e); }
    }
    const only = summarizeFromText(title, description);
    if (vErr && !hasContent(only)) only.debug = vErr;
    return only;
  }
  let data;
  try {
    const transcript = await getTranscript(videoId);
    data = await summarizeWithGemini(title, description, tags, transcript);
  } catch {
    data = summarizeFromText(title, description);
  }
  if (videoOn && !isFull(data)) {
    try { const v = await summarizeWithGeminiVideo(videoId, durSec); if (hasContent(v)) return v; } catch (e) { vErr = cleanErr(e); }
  }
  if (vErr && !hasContent(data)) data.debug = vErr;
  return data;
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
    const vp = new URLSearchParams({ key, part: "snippet,contentDetails", id: videoId });
    const vJson = await (await fetch(`${YT}/videos?${vp}`)).json();
    const sn = vJson?.items?.[0]?.snippet;
    if (!sn) return res.status(404).json({ error: "영상을 찾을 수 없습니다." });
    const durSec = parseDurSec(vJson?.items?.[0]?.contentDetails?.duration);
    const title = sn.title || "", description = sn.description || "", tags = (sn.tags || []).join(", ");
    let data;
    if (process.env.GEMINI_API_KEY) {
      data = await smartSummarize(videoId, title, description, tags, durSec);
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
    if (hasContent(data)) cache.set(videoId, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "요약 중 오류: " + (e?.message || String(e)) });
  }
}
