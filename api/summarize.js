// /api/summarize?videoId=...  —  영상 설명 + 자막을 재료·조리법으로 구조화
const YT = "https://www.googleapis.com/youtube/v3";
const cache = new Map();
const TTL = 1000 * 60 * 60 * 24;

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
    await fetch(u, { method: "POST", headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify(["SET", key, JSON.stringify(val), "EX", 2592000]) });
  } catch {}
}

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

function cleanDescription(desc) {
  const out = [];
  for (const raw of (desc || "").split(/\r?\n/)) {
    const s = raw.trim();
    if (!s) continue;
    if (/https?:\/\/|www\.|youtu\.?be|\.com|\.net|@[A-Za-z0-9_]/i.test(s)) continue;
    if (/구독|좋아요|알림\s*설정|인스타|스토어|블로그|카페|문의|협찬|광고|비즈니스|이메일|메일|후원|계좌|멤버십|subscribe|follow|instagram|sponsor|business|e-?mail/i.test(s)) continue;
    if (/^[#＃]/.test(s) || (s.match(/[#＃]/g) || []).length >= 2) continue;
    if (/^\d{1,2}:\d{2}/.test(s)) continue;
    out.push(s);
  }
  return out.join("\n").slice(0, 2200);
}
function buildPrompt(title, description, tags, transcript) {
  const t = (transcript || "").trim();
  const hasT = t.length > 30;
  const desc = cleanDescription(description);
  return "당신은 요리 레시피 정리 전문가입니다. 아래 유튜브 영상에서 '제목'에 해당하는 요리 하나의 레시피만 정리하세요.\n"
    + "규칙:\n"
    + "1) " + (hasT ? "자막을 최우선 근거로 삼고, 설명은 재료·분량 보완에만 사용하세요." : "제목과 명백히 관련된 재료·조리법만 사용하세요.") + "\n"
    + "2) 설명에 들어 있는 다른 요리, 홍보, 링크, 해시태그, 타 영상/뉴스/기사 소개는 절대 사용하지 마세요.\n"
    + "3) 확실하지 않으면 지어내지 말고, 재료·조리법을 못 찾으면 빈 배열로 두세요.\n"
    + "4) ingredients에는 재료만(예: 대파 1대), steps에는 조리 동작 문장만.\n\n"
    + "[제목]\n" + title + "\n\n[자막]\n" + (t || "(자막 없음)") + "\n\n[설명(참고용, 노이즈 가능)]\n" + desc
    + "\n\n[태그]\n" + (tags || "(없음)");
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

const SYS = {
  ko: "너는 한국어로만 답하는 요리 도우미다. dish, ingredients, steps, tips의 모든 값을 반드시 자연스러운 한국어로 작성한다. 어떤 경우에도 영어 문장으로 답하지 않는다.",
  en: "You are a cooking assistant. Write ALL values of dish, ingredients (item and amount), steps and tips in natural English. Never answer in another language.",
  es: "Eres un asistente de cocina. Escribe TODOS los valores de dish, ingredients (item y amount), steps y tips en español natural. Nunca respondas en otro idioma.",
};
let curLang = "ko";
function sysIns() { return { parts: [{ text: SYS[curLang] || SYS.ko }] }; }

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
    systemInstruction: sysIns(), contents: [{ parts: [{ text: buildPrompt(title, description, tags, transcript) }] }],
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
  const body = { systemInstruction: sysIns(), contents: [{ parts }], generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2, maxOutputTokens: 4096 } };
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
  let data, transcript = "";
  try {
    transcript = await getTranscript(videoId);
    data = await summarizeWithGemini(title, description, tags, transcript);
  } catch {
    data = summarizeFromText(title, description);
  }
  const thinTranscript = (transcript || "").replace(/\s+/g, "").length < 150;
  if (videoOn && (!isFull(data) || thinTranscript)) {
    try { const v = await summarizeWithGeminiVideo(videoId, durSec); if (hasContent(v)) return v; } catch (e) { vErr = cleanErr(e); }
  }
  if (vErr && !hasContent(data)) data.debug = vErr;
  return data;
}

function withBudget(promise, ms, fallbackFn) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(fallbackFn()); } }, ms);
    Promise.resolve(promise).then(v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
      .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(fallbackFn()); } });
  });
}

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "YOUTUBE_API_KEY가 설정되지 않았습니다." });
  const url = new URL(req.url, "http://localhost");
  const videoId = url.searchParams.get("videoId");
  if (!videoId) return res.status(400).json({ error: "videoId가 필요합니다." });
  const lang = (url.searchParams.get("lang") || "ko"); curLang = lang; const ck = lang + ":" + videoId;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return res.status(200).json(hit.data);
  const kv = await kvGet("sum:" + ck);
  if (kv) { cache.set(ck, { at: Date.now(), data: kv }); return res.status(200).json(kv); }
  try {
    const vp = new URLSearchParams({ key, part: "snippet,contentDetails", id: videoId });
    const vJson = await (await fetch(`${YT}/videos?${vp}`)).json();
    const sn = vJson?.items?.[0]?.snippet;
    if (!sn) return res.status(404).json({ error: "영상을 찾을 수 없습니다." });
    const durSec = parseDurSec(vJson?.items?.[0]?.contentDetails?.duration);
    const title = sn.title || "", description = sn.description || "", tags = (sn.tags || []).join(", ");
    let data;
    if (process.env.GEMINI_API_KEY) {
      data = await withBudget(smartSummarize(videoId, title, description, tags, durSec), 50000, () => {
        const t = summarizeFromText(title, description);
        t.note = "영상 분석이 오래 걸려 설명 기반 간단 요약만 제공했어요. 정확한 계량·시간은 ‘영상에서 보기’로 확인해 주세요.";
        t._partial = true;
        return t;
      });
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
    if (hasContent(data) && !data._partial) { cache.set(ck, { at: Date.now(), data }); await kvSet("sum:" + ck, data); }
    if (data._partial) res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: "요약 중 오류: " + (e?.message || String(e)) });
  }
}
