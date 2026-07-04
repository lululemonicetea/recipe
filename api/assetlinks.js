// /.well-known/assetlinks.json 로 매핑됨(vercel.json rewrite)
// PWABuilder가 알려주는 SHA256 지문을 환경변수에 넣으면 TWA 주소창이 사라집니다.
export default function handler(req, res) {
  const pkg = process.env.ANDROID_PACKAGE || "com.lululemonicetea.recipetube";
  const fp = (process.env.ANDROID_FINGERPRINT || "").trim();
  res.setHeader("Content-Type", "application/json");
  res.status(200).json([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: fp ? [fp] : [] },
  }]);
}
