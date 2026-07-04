// /api/coupang?q=재료1|재료2  —  재료명을 쿠팡 검색 링크로,
// 쿠팡 파트너스 키가 있으면 어필리에이트 딥링크(수수료 적립)로 변환한다.
// 키가 없으면 일반 검색 링크로 폴백(수수료 미적립)한다.
import crypto from "node:crypto";

const DOMAIN = "https://api-gateway.coupang.com";
const PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

// 쿠팡 서명 시각: yyMMdd'T'HHmmss'Z' (GMT)
function signedDate() {
  return new Date().toISOString().substr(2, 17).replace(/[-:]/g, "") + "Z";
}

function searchUrl(name) {
  return `https://www.coupang.com/np/search?q=${encodeURIComponent(name)}&channel=recipetube`;
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const q = url.searchParams.get("q") || "";
  const names = [...new Set(q.split("|").map(s => s.trim()).filter(Boolean))].slice(0, 20);
  if (!names.length) return res.status(400).json({ error: "재료가 없습니다." });

  const urls = names.map(searchUrl);
  const ACCESS = process.env.COUPANG_ACCESS_KEY, SECRET = process.env.COUPANG_SECRET_KEY;

  // 키 없으면 일반 검색 링크로 폴백
  if (!ACCESS || !SECRET) {
    return res.status(200).json({ tracked: false, items: names.map((n, i) => ({ name: n, url: urls[i] })) });
  }

  try {
    const datetime = signedDate();
    const message = datetime + "POST" + PATH;
    const signature = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
    const auth = `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${datetime}, signature=${signature}`;

    const body = { coupangUrls: urls };
    if (process.env.COUPANG_SUB_ID) body.subId = process.env.COUPANG_SUB_ID;

    const r = await fetch(DOMAIN + PATH, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j.data)) {
      return res.status(200).json({
        tracked: false,
        items: names.map((n, i) => ({ name: n, url: urls[i] })),
        warn: j?.rMessage || "쿠팡 딥링크 생성 실패(일반 링크로 대체)",
      });
    }
    const items = names.map((n, i) => ({
      name: n,
      url: (j.data[i] && (j.data[i].shortenUrl || j.data[i].landingUrl)) || urls[i],
    }));
    return res.status(200).json({ tracked: true, items });
  } catch (e) {
    return res.status(200).json({
      tracked: false,
      items: names.map((n, i) => ({ name: n, url: urls[i] })),
      warn: "오류로 일반 링크 대체: " + (e?.message || ""),
    });
  }
}
