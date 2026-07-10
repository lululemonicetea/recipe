/* 레시피튜브 프론트엔드 — 검색, 저장(별표), 유사검색 우선노출, 레시피 요약 모달, 장보기 */
"use strict";

/* ---------- 저장소 ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
let saved   = store.get("rt_saved", []);
let history = store.get("rt_history", []);
let cart    = store.get("rt_cart", []);
let theme   = store.get("rt_theme", "light");
let sumCache = store.get("rt_sum2", {});
let collapsed = store.get("rt_collapsed", {});

/* ---------- 유틸 ---------- */
const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
const esc = s => (s || "").replace(/[&<>"']/g, m => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const STOP = new Set(["레시피","만들기","만드는법","만드는","요리","맛있는","황금","초간단","간단","쉬운","백종원","진짜","완벽","비법","최고","존맛","집에서","방법","how","to","recipe","the","for","이","그","및","와","과"]);
function tokenize(str) {
  return [...new Set((str || "").toLowerCase()
    .replace(/[^가-힣a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP.has(w)))];
}
function overlaps(a, b) { const B = new Set(b); return a.some(t => B.has(t)); }

function fmtViews(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n/1e8).toFixed(1).replace(/\.0$/,"") + "억회";
  if (n >= 1e4) return (n/1e4).toFixed(1).replace(/\.0$/,"") + "만회";
  return n.toLocaleString("ko-KR") + "회";
}
function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (d < 1) return "오늘"; if (d < 7) return Math.floor(d) + "일 전";
  if (d < 30) return Math.floor(d/7) + "주 전"; if (d < 365) return Math.floor(d/30) + "개월 전";
  return Math.floor(d/365) + "년 전";
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 2200);
}

/* ---------- 뷰 전환 ---------- */
function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $("#view-" + name).classList.add("active");
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === name));
  if (name === "saved") renderSaved();
  if (name === "cart") renderCart();
  if (name === "eat") renderEat();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach(t => t.onclick = () => showView(t.dataset.view));
$("#brandHome").onclick = goHome;

/* ---------- 검색 ---------- */
let lastResults = new Map();  // id -> video
let nextPageToken = null;
let currentQuery = "";

function isSaved(id) { return saved.some(s => s.id === id); }

async function doSearch(query, append = false) {
  const q = (query ?? $("#q").value).trim();
  if (!q) return;
  currentQuery = q;
  $("#q").value = q;
  hideHome();
  if (!append) {
    lastResults.clear();
    $("#results").innerHTML = "";
    $("#savedTop").classList.add("hidden");
    addHistory(q);
    renderSavedTop(q);
  }
  const order = $("#order").value;
  const status = $("#status");
  status.innerHTML = '<span class="spinner"></span>';
  $("#moreBtn").classList.add("hidden");
  try {
    const url = `/api/search?q=${encodeURIComponent(q)}&order=${order}` + (append && nextPageToken ? `&pageToken=${nextPageToken}` : "");
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "검색 실패");
    nextPageToken = data.nextPageToken;

    // 이미 상단에 뜬 저장영상은 결과에서 제외(중복 방지)
    const topIds = new Set([...document.querySelectorAll("#savedTopGrid .card")].map(c => c.dataset.id));
    const items = data.items.filter(v => !topIds.has(v.id));
    items.forEach(v => lastResults.set(v.id, v));

    if (!append && items.length === 0 && topIds.size === 0) {
      status.textContent = "검색 결과가 없어요. 다른 검색어를 시도해 보세요.";
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach(v => frag.appendChild(card(v)));
    $("#results").appendChild(frag);
    status.textContent = "";
    $("#resultMeta").textContent = `“${q}” 성과 좋은 순 상위 영상`;
    if (nextPageToken) $("#moreBtn").classList.remove("hidden");
  } catch (e) {
    status.textContent = "⚠ " + e.message;
  }
}

function renderSavedTop(q) {
  const qt = tokenize(q);
  const matches = saved.filter(s => overlaps(qt, s.queryTokens || [])).slice(0, 4);
  const wrap = $("#savedTop"), grid = $("#savedTopGrid");
  grid.innerHTML = "";
  if (matches.length === 0) { wrap.classList.add("hidden"); return; }
  matches.forEach(v => {
    lastResults.set(v.id, v);
    const row = el("div", "saved-row");
    const left = el("div", "saved-left");
    left.appendChild(card(v, true));
    const right = el("div", "saved-right");
    row.appendChild(left);
    row.appendChild(right);
    grid.appendChild(row);
    if (getSum(v.id)) {
      right.innerHTML = '<div class="mini-loading"><span class="spinner"></span><span>불러오는 중…</span></div>';
      loadInlineRecipe(v.id, right);
    } else {
      right.innerHTML = '<button class="btn-recipe" style="width:100%;padding:12px">🍳 레시피 요약 보기</button>';
      right.firstChild.onclick = () => { right.innerHTML = '<div class="mini-loading"><span class="spinner"></span><span>불러오는 중…</span></div>'; loadInlineRecipe(v.id, right); };
    }
  });
  wrap.classList.remove("hidden");
}

/* ---------- 카드 ---------- */
function card(v, isTop = false) {
  const c = el("div", "card"); c.dataset.id = v.id;
  const on = isSaved(v.id);
  c.innerHTML = `
    <div class="thumb" data-open="${v.id}">
      ${isTop ? '<span class="ribbon">⭐ 저장함</span>' : ""}
      <img loading="lazy" src="${esc(v.thumbnail)}" alt="">
      ${v.durationText ? `<span class="dur">${esc(v.durationText)}</span>` : ""}
      <span class="play">▶</span>
    </div>
    <div class="card-body">
      <p class="card-title">${esc(v.title)}</p>
      <div class="card-meta">
        <span>${esc(v.channel)}</span>
        ${v.viewCount ? `<span>· ${fmtViews(v.viewCount)}</span>` : ""}
        ${v.publishedAt ? `<span>· ${timeAgo(v.publishedAt)}</span>` : ""}
      </div>
      <div class="card-actions">
        <button class="star ${on ? "on" : ""}" data-star="${v.id}" title="저장">${on ? "★" : "☆"}</button>
        <button class="btn-recipe" data-recipe="${v.id}">레시피 요약</button>
      </div>
    </div>`;
  return c;
}

// 이벤트 위임
document.body.addEventListener("click", e => {
  const openEl = e.target.closest("[data-open]");
  const starEl = e.target.closest("[data-star]");
  const recEl  = e.target.closest("[data-recipe]");
  if (openEl) { const v = lastResults.get(openEl.dataset.open); if (v) window.open(v.url, "_blank", "noopener"); }
  if (starEl) toggleStar(starEl.dataset.star, starEl);
  if (recEl)  openRecipe(recEl.dataset.recipe);
});

/* ---------- 저장(별표) ---------- */
function toggleStar(id, btn) {
  const v = lastResults.get(id);
  if (isSaved(id)) {
    saved = saved.filter(s => s.id !== id);
    toast("저장 해제했어요");
  } else if (v) {
    saved.unshift({
      id: v.id, title: v.title, channel: v.channel, thumbnail: v.thumbnail,
      url: v.url, durationText: v.durationText, viewCount: v.viewCount, publishedAt: v.publishedAt,
      queryTokens: [...new Set([...tokenize(currentQuery), ...tokenize(v.title)])],
      savedAt: Date.now(),
    });
    toast("⭐ 저장했어요! 다음에 비슷한 메뉴를 검색하면 맨 위에 나와요");
    if (!getSum(id)) fetchSummary(id).catch(() => {});
  }
  store.set("rt_saved", saved);
  updateCounts();
  // 화면의 모든 동일 id 별 버튼 갱신
  document.querySelectorAll(`[data-star="${id}"]`).forEach(b => {
    const s = isSaved(id); b.classList.toggle("on", s); b.textContent = s ? "★" : "☆";
  });
}

/* ---------- 레시피 모달 ---------- */
let modalState = { recipe: null, mult: 1 };

function scaleAmount(amount, mult) {
  if (!amount || mult === 1) return amount;
  const frac = amount.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) { const val = (+frac[1] / +frac[2]) * mult; return amount.replace(frac[0], trim(val)); }
  return amount.replace(/(\d+(?:[.,]\d+)?)/, m => trim(parseFloat(m.replace(",", ".")) * mult));
}
const trim = n => (Math.round(n * 100) / 100).toString();

function getSum(id) { const h = sumCache[id]; return h && (Date.now() - h.at < 86400000) ? h.data : null; }
function putSum(id, data) {
  const ok = (data.ingredients || []).some(i => i && (i.item || i.amount)) || (data.steps || []).length > 0;
  if (!ok) return;
  sumCache[id] = { data, at: Date.now() };
  const ks = Object.keys(sumCache);
  if (ks.length > 120) { ks.sort((a, b) => sumCache[a].at - sumCache[b].at); delete sumCache[ks[0]]; }
  store.set("rt_sum2", sumCache);
}
async function fetchSummary(id) {
  const c = getSum(id); if (c) return c;
  const res = await fetch(`/api/summarize?videoId=${id}`);
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || "요약 실패");
  putSum(id, d);
  return d;
}

async function openRecipe(id) {
  const v = lastResults.get(id);
  trackRecent(v);
  maybeRatePrompt();
  $("#modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  pushOverlay();
  $("#modalBody").innerHTML = '<div style="text-align:center;padding:50px"><span class="spinner"></span><p class="muted">영상을 보고 재료·조리법을 정리하고 있어요…</p></div>';
  try {
    const data = await fetchSummary(id);
    data._url = v?.url || `https://www.youtube.com/watch?v=${id}`;
    data._id = id;
    modalState = { recipe: data, mult: 1 };
    renderModal();
  } catch (e) {
    $("#modalBody").innerHTML = `<p class="note">⚠ ${esc(e.message)}</p>`;
  }
}

// 재료/순서 HTML 생성 (모달 + 저장영상 인라인 공용)
function recipeBodyHTML(d, m, opts = {}) {
  const ing = (d.ingredients || []).filter(i => i && (i.item || i.amount));
  const steps = (d.steps || []).filter(Boolean);
  const tips = (d.tips || []).filter(Boolean);
  const badge = d.source === "ai-video" ? '<span class="pill ai">AI 영상 분석</span>' : d.source === "ai" ? '<span class="pill ai">AI 요약</span>' : '<span class="pill text">설명 기반</span>';
  const empty = !ing.length && !steps.length;
  const serv = opts.stepper && ing.length
    ? `<div class="serv">분량 <button data-mult="-1">－</button> <b>×${m}</b> <button data-mult="1">＋</button></div>` : "";
  return `
    <h2>${esc(d.dish || "레시피")}</h2>
    <div class="sub">
      ${badge}
      ${d.servings ? `<span>👥 <b>${esc(d.servings)}</b></span>` : ""}
      ${d.totalTime ? `<span>⏱ <b>${esc(d.totalTime)}</b></span>` : ""}
      ${d.difficulty ? `<span>🔥 <b>${esc(d.difficulty)}</b></span>` : ""}
    </div>
    ${d.aiError ? `<div class="note">${esc(d.aiError)}</div>` : ""}
    ${d.debug ? `<div class="note" style="font-size:11px;opacity:.6">${esc(d.debug)}</div>` : ""}
    ${d.note ? `<div class="note">${esc(d.note)}</div>` : ""}
    ${empty && !d.note ? `<div class="note">자막·설명이 부족해 정리할 재료·순서를 찾지 못했어요. ‘영상에서 보기’로 확인해 주세요.</div>` : ""}
    ${ing.length ? `
    <div class="section-h"><h3>🧺 재료</h3>${serv}</div>
    <ul class="ing-list">
      ${ing.map(i => `<li><span>${esc(i.item || "")}</span><span class="amt">${esc(scaleAmount(i.amount, m) || "")}</span></li>`).join("")}
    </ul>` : ""}
    ${steps.length ? `
    <div class="section-h"><h3>👩‍🍳 조리 순서</h3></div>
    <ol class="steps">${steps.map(s => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    ${tips.length ? `<div class="tips"><b>💡 팁</b><ul>${tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
    <div class="modal-cta">
      <a class="cta-watch" href="${esc(d._url || ("https://www.youtube.com/watch?v=" + (d.videoId || "")))}" target="_blank" rel="noopener">▶ 영상에서 보기</a>
      ${steps.length ? `<button class="cta-cook">🍳 조리 시작</button>` : ""}
      ${ing.length ? `<button class="cta-cart">🛒 장보기 담기</button>` : ""}
      <button class="cta-share">↗ 공유</button>
    </div>`;
}

function wireRecipe(scope, d, m, isModal) {
  if (isModal) {
    scope.querySelectorAll("[data-mult]").forEach(b => b.onclick = () => {
      modalState.mult = Math.max(0.5, Math.round((modalState.mult + 0.5 * +b.dataset.mult) * 2) / 2);
      renderModal();
    });
  }
  const ing = (d.ingredients || []).filter(i => i && (i.item || i.amount));
  const tc = scope.querySelector(".cta-cart");
  if (tc) tc.onclick = () => addIngredientsToCart(ing, d.dish, m);
  const ck = scope.querySelector(".cta-cook");
  if (ck) ck.onclick = () => startCook(d);
  const sh = scope.querySelector(".cta-share");
  if (sh) sh.onclick = () => shareRecipeCard(d);
}

// 저장한 영상: 오른쪽에 레시피 자동 표시
async function loadInlineRecipe(id, container) {
  try {
    const d = await fetchSummary(id);
    d._url = (lastResults.get(id) || {}).url || `https://www.youtube.com/watch?v=${id}`;
    container.innerHTML = `<div class="recipe compact">${recipeBodyHTML(d, 1, { stepper: false })}</div>`;
    wireRecipe(container, d, 1, false);
  } catch (e) {
    container.innerHTML = `<div class="note">⚠ ${esc(e.message)}</div>`;
  }
}

function renderModal() {
  const d = modalState.recipe, m = modalState.mult;
  $("#modalBody").innerHTML = `<div class="recipe">${recipeBodyHTML(d, m, { stepper: true })}</div>`;
  wireRecipe($("#modalBody"), d, m, true);
}

function closeModal(fromPop) { $("#modal").classList.add("hidden"); document.body.style.overflow = ""; if (fromPop !== true) history.back(); }
$("#modalClose").onclick = closeModal;
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- 장보기 ---------- */
function addIngredientsToCart(ing, src, mult) {
  let added = 0;
  ing.forEach(i => {
    const name = (i.item || "").trim();
    const text = `${name} ${scaleAmount(i.amount, mult) || ""}`.trim();
    if (!text) return;
    if (cart.some(c => c.text === text && c.src === (src || ""))) return;
    cart.push({ id: uid(), text, name: name || text, src: src || "", done: false });
    added++;
  });
  store.set("rt_cart", cart); updateCounts();
  toast(added ? `🛒 ${added}개 재료를 담았어요` : "이미 담겨 있어요");
}

let bannerDismissed = false;
function renderBanner() {
  const w = $("#cartBannerWrap"); if (!w) return;
  const code = (window.COUPANG_BANNER || "").trim();
  if (!code || bannerDismissed) { w.classList.add("hidden"); w.innerHTML = ""; return; }
  w.classList.remove("hidden");
  w.innerHTML = `<div class="cb-head"><span>쿠팡 파트너스 · 광고</span><button id="cbClose" aria-label="닫기">✕</button></div><div class="cb-body">${code}</div>`;
  const x = $("#cbClose"); if (x) x.onclick = () => { bannerDismissed = true; renderBanner(); };
}

function renderCart() {
  renderBanner();
  const list = $("#cartList");
  const remain = cart.filter(c => !c.done).length;
  const done = cart.length - remain;
  const fab = document.getElementById("cartFab");
  if (fab) fab.textContent = remain ? `🛒 쿠팡에서 재료 구매하기 (${remain})` : "🛒 쿠팡에서 재료 구매하기";
  const sa = document.getElementById("cartSelectAll");
  if (sa) sa.textContent = cart.length && remain === 0 ? "↺ 전체 해제" : "✓ 전체 있음";
  const ca = document.getElementById("cartCollapseAll");
  list.innerHTML = "";
  if (cart.length === 0) { list.innerHTML = '<p class="muted">목록이 비어 있어요. 레시피에서 재료를 담아보세요.</p>'; if (ca) ca.style.display = "none"; return; }
  const pct = Math.round(done / cart.length * 100);
  const prog = el("div", "cart-progress");
  prog.innerHTML = `<div class="cart-progress-t"><span>있음 <b>${done}</b> · 살 것 <b>${remain}</b></span><span>${pct}%</span></div><div class="cart-bar"><div style="width:${pct}%"></div></div>`;
  list.appendChild(prog);
  const groups = {};
  cart.forEach(it => { const k = it.src || "직접추가"; (groups[k] = groups[k] || []).push(it); });
  const srcs = Object.keys(groups);
  if (ca) { ca.style.display = srcs.length > 1 ? "" : "none"; ca.textContent = srcs.every(s => collapsed[s]) ? "▸ 모두 펼치기" : "▾ 모두 접기"; }
  srcs.forEach(src => {
    const items = groups[src];
    const gd = items.filter(i => i.done).length;
    const isCol = !!collapsed[src];
    const g = el("div", "cart-group");
    const head = el("div", "cart-group-h");
    head.innerHTML = `<span class="cg-toggle">${isCol ? "▸" : "▾"}</span><span class="cg-name">🍽 ${esc(src)}</span><span class="cart-group-n">${gd}/${items.length}</span>`;
    head.onclick = () => { if (collapsed[src]) delete collapsed[src]; else collapsed[src] = true; store.set("rt_collapsed", collapsed); renderCart(); };
    g.appendChild(head);
    if (!isCol) {
      const ul = el("ul", "cart-list");
      items.forEach(item => {
        const li = el("li", item.done ? "done" : "");
        li.innerHTML = `<span class="ck">${item.done ? "✓" : ""}</span><label>${esc(item.text)}</label>${item.done ? '<span class="have">있음</span>' : `<button class="cp-btn" data-cp="${item.id}" aria-label="쿠팡에서 구매">🛒</button>`}<button class="del" data-del="${item.id}" aria-label="삭제">🗑</button>`;
        li.onclick = e => { if (e.target.closest("[data-del]") || e.target.closest("[data-cp]")) return; item.done = !item.done; store.set("rt_cart", cart); updateCounts(); renderCart(); };
        ul.appendChild(li);
      });
      g.appendChild(ul);
    }
    list.appendChild(g);
  });
  list.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    cart = cart.filter(c => c.id !== b.dataset.del); store.set("rt_cart", cart); updateCounts(); renderCart();
  });
  list.querySelectorAll("[data-cp]").forEach(b => b.onclick = e => { e.stopPropagation(); const it = cart.find(c => c.id === b.dataset.cp); if (it) goCoupang([it.name || it.text]); });
}

$("#cartSelectAll").onclick = () => {
  const anyOff = cart.some(c => !c.done);
  cart.forEach(c => c.done = anyOff);
  store.set("rt_cart", cart); renderCart();
};
$("#cartCollapseAll").onclick = () => {
  const gs = [...new Set(cart.map(c => c.src || "직접추가"))];
  if (gs.every(s => collapsed[s])) collapsed = {}; else gs.forEach(s => collapsed[s] = true);
  store.set("rt_collapsed", collapsed); renderCart();
};

// 쿠팡에서 재료 담기 (체크된 재료 → 쿠팡 파트너스 어필리에이트 링크)
async function openCoupang() {
  const remain = cart.filter(c => !c.done);
  if (!remain.length) return toast("모든 재료가 준비됐어요 🎉");
  const names = [...new Set(remain.map(c => c.name || c.text))];
  $("#modal").classList.remove("hidden"); document.body.style.overflow = "hidden";
  pushOverlay();
  $("#modalBody").innerHTML = '<div style="text-align:center;padding:40px"><span class="spinner"></span><p class="muted">쿠팡 상품 링크를 준비하고 있어요…</p></div>';
  try {
    const res = await fetch(`/api/coupang?q=${encodeURIComponent(names.join("|"))}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "쿠팡 링크 생성 실패");
    const rows = data.items.map(it => `
      <a class="coupang-row" href="${esc(it.url)}" target="_blank" rel="noopener nofollow sponsored">
        <span>${esc(it.name)}</span><span class="cta">쿠팡에서 담기 ▸</span>
      </a>`).join("");
    $("#modalBody").innerHTML = `
      <div class="recipe">
        <h2>🛒 쿠팡에서 장보기</h2>
        <p class="muted" style="font-size:13px;margin:2px 0 10px">쿠팡에 한 번 들어가면 <b>24시간 안에 담는 모든 상품</b>이 자동으로 집계돼요. 아래 버튼으로 시작한 뒤, 재료를 하나씩 검색해 담으세요.${data.tracked ? "" : "<br>· 쿠팡 파트너스 키를 넣으면 구매 시 수수료가 적립됩니다."}</p>
        <div class="modal-cta" style="margin:0 0 12px">
          <a class="cta-watch" href="${esc(data.items[0].url)}" target="_blank" rel="noopener nofollow sponsored">🛒 쿠팡에서 장보기 시작</a>
          <button class="cta-cart" id="coupangCopy">📋 재료 목록 복사</button>
        </div>
        <div class="coupang-list">${rows}</div>
        <div class="note" style="font-size:12px;margin-top:10px">이 앱은 쿠팡 파트너스 활동의 일환으로, 구매 발생 시 일정액의 수수료를 제공받을 수 있습니다.</div>
      </div>`;
    const cc = document.getElementById("coupangCopy");
    if (cc) cc.onclick = async () => {
      try { await navigator.clipboard.writeText(names.join("\n")); toast("재료 목록을 복사했어요 — 쿠팡에서 붙여넣어 검색하세요"); }
      catch { toast("복사 실패 — 길게 눌러 복사해 주세요"); }
    };

  } catch (e) {
    $("#modalBody").innerHTML = `<p class="note">⚠ ${esc(e.message)}</p>`;
  }
}
function goCoupang(names) {
  names = [...new Set((names || []).filter(Boolean))];
  if (!names.length) return toast("담을 재료가 없어요");
  const w = window.open("about:blank", "_blank");
  if (navigator.clipboard) navigator.clipboard.writeText(names.join("\n")).catch(() => {});
  const fallback = `https://www.coupang.com/np/search?q=${encodeURIComponent(names[0])}`;
  fetch(`/api/coupang?q=${encodeURIComponent(names.join("|"))}`)
    .then(r => r.json())
    .then(d => { const u = (d.items && d.items[0] && d.items[0].url) || fallback; if (w) w.location = u; else location.href = u; toast("쿠팡으로 이동 · 재료 목록을 복사했어요"); })
    .catch(() => { if (w) w.location = fallback; });
}
$("#cartFab").onclick = openCoupang;


$("#cartAddBtn").onclick = () => {
  const v = $("#cartInput").value.trim(); if (!v) return;
  cart.push({ id: uid(), text: v, name: v, src: "직접추가", done: false });
  $("#cartInput").value = ""; store.set("rt_cart", cart); updateCounts(); renderCart();
};
$("#cartInput").addEventListener("keydown", e => { if (e.key === "Enter") $("#cartAddBtn").click(); });
$("#cartShare").onclick = shareCartList;
$("#cartCopy").onclick = async () => {
  if (cart.length === 0) return toast("목록이 비어 있어요");
  const text = "🛒 장보기 목록\n" + cart.map(c => `▢ ${c.text}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast("목록을 복사했어요"); }
  catch { toast("복사 실패 — 길게 눌러 복사해 주세요"); }
};
$("#cartClearChecked").onclick = () => { cart = cart.filter(c => !c.done); store.set("rt_cart", cart); updateCounts(); renderCart(); };
$("#cartClearAll").onclick = () => { if (confirm("장보기 목록을 모두 비울까요?")) { cart = []; store.set("rt_cart", cart); updateCounts(); renderCart(); } };

/* ---------- 저장함 ---------- */
function renderSaved() {
  const grid = $("#savedGrid");
  grid.innerHTML = "";
  $("#savedEmpty").style.display = saved.length ? "none" : "block";
  saved.forEach(v => { lastResults.set(v.id, v); grid.appendChild(card(v)); });
}

/* ---------- 검색 기록 ---------- */
function addHistory(q) {
  history = [q, ...history.filter(h => h !== q)].slice(0, 12);
  store.set("rt_history", history); renderHistory();
}
function renderHistory() {
  const box = $("#history"); box.innerHTML = "";
  history.forEach(h => {
    const c = el("span", "chip hist-chip");
    c.innerHTML = `<span class="hist-q">${esc(h)}</span><span class="hist-x">✕</span>`;
    c.querySelector(".hist-q").onclick = () => doSearch(h);
    c.querySelector(".hist-x").onclick = (e) => { e.stopPropagation(); history = history.filter(x => x !== h); store.set("rt_history", history); renderHistory(); };
    box.appendChild(c);
  });
  if (history.length) { const clr = el("span", "chip hist-clear"); clr.textContent = "전체 지우기"; clr.onclick = () => { history = []; store.set("rt_history", history); renderHistory(); }; box.appendChild(clr); }
}

/* ---------- 공통 ---------- */
function updateCounts() {
  $("#savedCount").textContent = saved.length;
  $("#cartCount").textContent = cart.filter(c => !c.done).length;
}
function applyTheme() {
  document.documentElement.setAttribute("data-theme", theme);
  $("#themeToggle").textContent = theme === "dark" ? "☀️" : "🌙";
}
$("#themeToggle").onclick = () => { theme = theme === "dark" ? "light" : "dark"; store.set("rt_theme", theme); applyTheme(); };
$("#searchBtn").onclick = () => doSearch();
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
$("#order").onchange = () => { if (currentQuery) doSearch(currentQuery); };
$("#moreBtn").onclick = () => doSearch(currentQuery, true);

/* ---------- 조리 모드 ---------- */
let cook = { recipe: null, steps: [], i: 0, wake: null, timer: null, remain: 0 };
function parseStepSeconds(text) {
  const h = /(\d+)\s*시간/.exec(text), m = /(\d+)\s*분/.exec(text), s = /(\d+)\s*초/.exec(text);
  return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
}
async function keepAwake() { try { cook.wake = await navigator.wakeLock.request("screen"); } catch {} }
function releaseAwake() { try { cook.wake && cook.wake.release(); } catch {} cook.wake = null; }
document.addEventListener("visibilitychange", () => { if (cook.recipe && document.visibilityState === "visible" && !cook.wake) keepAwake(); });
function startCook(d) {
  const steps = (d.steps || []).filter(Boolean);
  if (!steps.length) return toast("조리 순서가 없어요");
  cook = { recipe: d, steps, i: 0, wake: null, timer: null, remain: 0 };
  $("#cookMode").classList.remove("hidden"); document.body.style.overflow = "hidden";
  pushOverlay();
  keepAwake(); renderCook();
}
function stopCook(fromPop) {
  clearInterval(cook.timer); releaseAwake();
  $("#cookMode").classList.add("hidden"); document.body.style.overflow = ""; cook.recipe = null;
  if (fromPop !== true) history.back();
}
function beep() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 880; o.start();
    g.gain.setValueAtTime(0.25, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.9);
    o.stop(a.currentTime + 0.9);
  } catch {}
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
}
function fmtT(s) { const m = Math.floor(s / 60), ss = s % 60; return m + ":" + String(ss).padStart(2, "0"); }
function startTimer(sec) {
  clearInterval(cook.timer); cook.remain = sec; renderCook();
  cook.timer = setInterval(() => {
    cook.remain--;
    const disp = document.getElementById("timerDisp");
    if (cook.remain <= 0) { clearInterval(cook.timer); cook.timer = null; beep(); if (disp) disp.textContent = "완료! ⏰"; return; }
    if (disp) disp.textContent = fmtT(cook.remain);
  }, 1000);
}
function renderCook() {
  const d = cook.recipe, steps = cook.steps, i = cook.i;
  const sec = parseStepSeconds(steps[i] || "");
  const ing = (d.ingredients || []).filter(x => x && (x.item || x.amount));
  const brief = t => { const c = String(t).replace(/^\d+[.)]\s*/, "").trim(); return c.length > 24 ? c.slice(0, 24) + "…" : c; };
  const listHtml = steps.map((s, idx) => {
    const active = idx === i, cls = active ? "active" : idx < i ? "past" : "future";
    return `<div class="cstep ${cls}" data-step="${idx}"><span class="cstep-n">${idx + 1}</span><span class="cstep-t">${active ? esc(s) : esc(brief(s))}</span></div>`;
  }).join("");
  $("#cookMode").innerHTML = `
    <div class="cook-top"><span class="cook-dish">${esc(d.dish || "레시피")}</span><button class="cook-x" id="cookClose">✕</button></div>
    <div class="cook-prog">${i + 1} / ${steps.length} 단계</div>
    <div class="cook-list">${listHtml}</div>
    ${sec ? `<div class="cook-timer"><button id="timerBtn">⏱ ${fmtT(sec)} 타이머 시작</button><div id="timerDisp" class="timer-disp">${cook.timer ? (cook.remain > 0 ? fmtT(cook.remain) : "완료! ⏰") : ""}</div></div>` : ""}
    <details class="cook-ing"><summary>🧺 재료 보기</summary><ul>${ing.map(x => `<li>${esc(x.item || "")} <b>${esc(x.amount || "")}</b></li>`).join("")}</ul></details>
    <div class="cook-nav">
      <button id="cookPrev" ${i === 0 ? "disabled" : ""}>← 이전</button>
      ${i < steps.length - 1 ? `<button id="cookNext" class="primary">다음 →</button>` : `<button id="cookDone" class="primary">완료 🎉</button>`}
    </div>`;
  $("#cookClose").onclick = stopCook;
  $("#cookMode").querySelectorAll("[data-step]").forEach(elm => elm.onclick = () => { cook.i = +elm.dataset.step; clearInterval(cook.timer); cook.timer = null; renderCook(); });
  const pv = $("#cookPrev"); if (pv) pv.onclick = () => { if (cook.i > 0) { cook.i--; clearInterval(cook.timer); cook.timer = null; renderCook(); } };
  const nx = $("#cookNext"); if (nx) nx.onclick = () => { cook.i++; clearInterval(cook.timer); cook.timer = null; renderCook(); };
  const dn = $("#cookDone"); if (dn) dn.onclick = stopCook;
  const tb = $("#timerBtn"); if (tb) tb.onclick = () => startTimer(sec);
  const act = $("#cookMode").querySelector(".cstep.active"); if (act) act.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---------- 공유 ---------- */
async function shareText(title, text, url) {
  try { if (navigator.share) { await navigator.share({ title, text, url }); return; } } catch { return; }
  try { await navigator.clipboard.writeText((text || "") + (url ? "\n" + url : "")); toast("복사했어요 — 붙여넣어 공유하세요"); }
  catch { toast("이 환경에선 공유가 어려워요"); }
}
function shareRecipe(d) {
  const ing = (d.ingredients || []).filter(i => i && (i.item || i.amount)).map(i => `- ${(i.item || "")} ${(i.amount || "")}`.trim()).join("\n");
  const text = `🍳 ${d.dish || "레시피"}\n\n[재료]\n${ing || "(영상 참고)"}\n\n레시피튜브`;
  shareText(d.dish || "레시피", text, d._url || location.origin);
}
function shareCartList() {
  if (!cart.length) return toast("목록이 비어 있어요");
  const text = "🛒 장보기 목록\n" + cart.map(c => `${c.done ? "✔" : "▢"} ${c.text}`).join("\n");
  shareText("장보기 목록", text, location.origin);
}

/* ---------- 홈(추천·최근본·인기) ---------- */
let recent = store.get("rt_recent", []);
const SUGGEST = ["김치찌개","된장찌개","제육볶음","김치볶음밥","마라탕","크림파스타","닭볶음탕","계란찜","오므라이스","떡볶이","김밥","불고기","비빔국수","순두부찌개","김치전","닭갈비","부대찌개","잡채","카레","볶음밥","미역국","갈비찜","감자탕","어묵탕","콩나물국밥","로제파스타","스크램블에그","두부조림","가지볶음","애호박전","삼겹살","라볶이","고등어조림","닭한마리","간장계란밥"];
function seededShuffle(arr, seed) { const a = arr.slice(); let s = seed || 1; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function trackRecent(v) {
  if (!v) return;
  recent = [{ id: v.id, title: v.title, channel: v.channel, thumbnail: v.thumbnail, url: v.url, durationText: v.durationText, viewCount: v.viewCount, publishedAt: v.publishedAt }, ...recent.filter(r => r.id !== v.id)].slice(0, 12);
  store.set("rt_recent", recent);
}
const TREND_QUERIES = ["인기 요리 레시피","간단 자취 요리","백종원 레시피","다이어트 요리","10분 요리","집밥 반찬","에어프라이어 요리","야식 레시피","안주 요리","캠핑 요리"];
async function loadTrending() {
  const today = new Date().toISOString().slice(0, 10);
  const q = TREND_QUERIES[new Date().getDate() % TREND_QUERIES.length];
  const cache = store.get("rt_trend", null);
  if (cache && cache.day === today && cache.items) return cache.items;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&order=views`);
    const data = await res.json();
    if (res.ok && data.items && data.items.length) { const seed = +(today.replace(/-/g, "")); const items = seededShuffle(data.items.slice(0, 16), seed).slice(0, 8); store.set("rt_trend", { day: today, items }); return items; }
  } catch {}
  return (cache && cache.items) || [];
}

const FRIDGE_ITEMS = ["계란","두부","김치","대파","양파","감자","당근","돼지고기","닭고기","밥","참치","애호박","버섯","스팸","어묵","콩나물","시금치","고구마","베이컨","떡"];
const CATEGORIES = [{ label: "국·찌개", q: "국 찌개 레시피" }, { label: "밑반찬", q: "밑반찬 레시피" }, { label: "면요리", q: "면 요리 레시피" }, { label: "볶음밥", q: "볶음밥 레시피" }, { label: "다이어트", q: "다이어트 요리 레시피" }, { label: "자취요리", q: "자취 요리 레시피" }, { label: "안주", q: "안주 레시피" }, { label: "디저트", q: "홈베이킹 디저트 레시피" }, { label: "에어프라이어", q: "에어프라이어 요리 레시피" }, { label: "도시락", q: "도시락 반찬 레시피" }, { label: "한그릇", q: "한그릇 요리 레시피" }, { label: "고기요리", q: "고기 요리 레시피" }];
let fridgeSel = [];

const EAT_GROUPS = [
  { icon: "⏰", title: "시간대", items: [{ label: "아침", q: "아침 간단 요리 레시피" }, { label: "브런치", q: "브런치 레시피" }, { label: "점심", q: "점심 메뉴 요리 레시피" }, { label: "저녁", q: "저녁 요리 레시피" }, { label: "야식", q: "야식 레시피" }, { label: "간식", q: "간식 만들기 레시피" }] },
  { icon: "🍽", title: "상황", items: [{ label: "혼밥", q: "혼밥 간단 요리 레시피" }, { label: "손님상", q: "손님 접대 요리 레시피" }, { label: "술안주", q: "간단 술안주 레시피" }, { label: "해장", q: "해장 요리 레시피" }, { label: "도시락", q: "도시락 반찬 레시피" }, { label: "캠핑", q: "캠핑 요리 레시피" }, { label: "집들이", q: "집들이 음식 레시피" }, { label: "아이반찬", q: "아이 반찬 레시피" }] },
  { icon: "🌦", title: "날씨·계절", items: [{ label: "비 오는 날", q: "부침개 전 요리 레시피" }, { label: "추운 날", q: "뜨끈한 국물 요리 레시피" }, { label: "더운 날", q: "시원한 여름 요리 레시피" }, { label: "환절기", q: "보양식 레시피" }] },
  { icon: "⚡", title: "빠르게·간편", items: [{ label: "시간 없을 때", q: "10분 초간단 요리 레시피" }, { label: "원팬", q: "원팬 요리 레시피" }, { label: "전자레인지", q: "전자레인지 요리 레시피" }, { label: "에어프라이어", q: "에어프라이어 요리 레시피" }, { label: "노오븐", q: "노오븐 디저트 레시피" }] },
  { icon: "🌶", title: "기분·맛", items: [{ label: "얼큰한 거", q: "얼큰한 요리 레시피" }, { label: "매운 거", q: "매운 음식 레시피" }, { label: "달달한 거", q: "달달한 디저트 레시피" }, { label: "느끼한 거", q: "느끼한 양식 레시피" }, { label: "담백한 거", q: "담백한 요리 레시피" }, { label: "개운한 거", q: "개운한 국물 요리 레시피" }] },
  { icon: "💪", title: "건강", items: [{ label: "다이어트", q: "다이어트 요리 레시피" }, { label: "저칼로리", q: "저칼로리 요리 레시피" }, { label: "고단백", q: "고단백 요리 레시피" }, { label: "채식", q: "채식 요리 레시피" }] },
];
let roulettePool = [], rlSpinning = false, rlLast = null;
function rouletteCardHtml(v) {
  if (!v) return `<div class="rl-empty">🎲 돌려서 오늘 뭐 먹을지 정해요!</div>`;
  return `<div class="rl-card" data-open="${v.id}"><div class="rl-thumb"><img loading="lazy" src="${esc(v.thumbnail)}" alt="">${v.durationText ? `<span class="dur">${esc(v.durationText)}</span>` : ""}</div><div class="rl-info"><div class="rl-title">${esc(v.title)}</div><div class="rl-ch">${esc(v.channel)}${v.viewCount ? " · " + fmtViews(v.viewCount) : ""}</div></div></div>`;
}
async function loadRoulettePool() {
  const now = new Date();
  const slot = now.toISOString().slice(0, 10) + (now.getHours() < 12 ? "-am" : "-pm");
  const cache = store.get("rt_roulette", null);
  if (cache && cache.slot === slot && cache.items && cache.items.length) { roulettePool = cache.items; return roulettePool; }
  const queries = ["인기 요리 레시피", "백종원 요리", "간단 저녁 요리", "자취 요리 레시피", "집밥 레시피", "맛있는 요리 레시피"];
  const idx = (now.getDate() * 2 + (now.getHours() < 12 ? 0 : 1)) % queries.length;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(queries[idx])}&order=views`);
    const data = await res.json();
    if (res.ok && data.items && data.items.length) { roulettePool = data.items.slice(0, 20); store.set("rt_roulette", { slot, items: roulettePool }); return roulettePool; }
  } catch {}
  roulettePool = (cache && cache.items) || [];
  return roulettePool;
}
async function spinRoulette() {
  if (rlSpinning) return;
  const pool = roulettePool.length ? roulettePool : await loadRoulettePool();
  if (!pool.length) { toast("메뉴를 불러오지 못했어요. 잠시 후 다시 시도해요"); return; }
  rlSpinning = true;
  const disp = $("#rlDisplay"), btn = $("#rlSpin"), rec = $("#rlResult");
  if (btn) btn.disabled = true; if (rec) rec.innerHTML = "";
  let delay = 60;
  const step = () => {
    const v = pool[Math.floor(Math.random() * pool.length)];
    if (disp) disp.innerHTML = rouletteCardHtml(v);
    delay *= 1.14;
    if (delay < 340) { setTimeout(step, delay); return; }
    let pick; do { pick = pool[Math.floor(Math.random() * pool.length)]; } while (pool.length > 1 && pick === rlLast);
    rlLast = pick; lastResults.set(pick.id, pick);
    if (disp) { disp.innerHTML = rouletteCardHtml(pick); const card = disp.querySelector(".rl-card"); if (card) { card.classList.add("rl-win"); card.onclick = () => openRecipe(pick.id); } }
    if (rec) { rec.innerHTML = `<button class="rl-open" id="rlOpen">🍳 이 레시피 보기</button><button class="rl-again" id="rlAgain">🎲 다시 돌리기</button>`; const o = $("#rlOpen"); if (o) o.onclick = () => openRecipe(pick.id); const ag = $("#rlAgain"); if (ag) ag.onclick = spinRoulette; }
    rlSpinning = false; if (btn) btn.disabled = false;
  };
  step();
}
function rouletteSectionHtml() {
  return `<div class="home-block rl-sec"><h2>🎲 오늘의 룰렛 <span style="font-size:12px;color:var(--muted);font-weight:400">· 유튜브 인기 메뉴 (하루 2번 갱신)</span></h2><div id="rlDisplay" class="rl-display">${rouletteCardHtml(null)}</div><button id="rlSpin" class="rl-spin">🎲 돌리기</button><div id="rlResult" class="rl-result"></div></div>`;
}
function wireRoulette() { const sp = $("#rlSpin"); if (sp) sp.onclick = spinRoulette; loadRoulettePool(); }
function renderFridge() {
  const b = $("#fridgeBlock"); if (!b) return;
  b.innerHTML = `<div class="eat-glabel">🧊 냉장고 파먹기</div>
    <div class="fridge-input"><input id="fridgeInput" type="text" placeholder="가진 재료 입력 (예: 애호박, 참치)"><button id="fridgeAdd">추가</button></div>
    ${fridgeSel.length ? `<div class="fridge-sel">${fridgeSel.map(f => `<span class="chip on" data-fr-rm="${esc(f)}">${esc(f)} ✕</span>`).join("")}</div>` : ""}
    <div class="history">${FRIDGE_ITEMS.map(f => `<span class="chip ${fridgeSel.includes(f) ? "on" : ""}" data-fr="${esc(f)}">${esc(f)}</span>`).join("")}</div>
    <button class="fridge-go" id="fridgeGo">🍳 이 재료로 레시피 찾기${fridgeSel.length ? ` (${fridgeSel.length})` : ""}</button>`;
  b.querySelectorAll("[data-fr]").forEach(c => c.onclick = () => { const f = c.dataset.fr; if (fridgeSel.includes(f)) fridgeSel = fridgeSel.filter(x => x !== f); else fridgeSel.push(f); renderFridge(); });
  b.querySelectorAll("[data-fr-rm]").forEach(c => c.onclick = () => { fridgeSel = fridgeSel.filter(x => x !== c.dataset.frRm); renderFridge(); });
  const inp = $("#fridgeInput"), add = $("#fridgeAdd");
  const doAdd = () => { (inp.value || "").split(/[,\s]+/).map(s => s.trim()).filter(Boolean).forEach(x => { if (!fridgeSel.includes(x)) fridgeSel.push(x); }); inp.value = ""; renderFridge(); };
  if (add) add.onclick = doAdd;
  if (inp) inp.onkeydown = e => { if (e.key === "Enter") doAdd(); };
  const go = $("#fridgeGo"); if (go) go.onclick = () => { if (!fridgeSel.length) return toast("가진 재료를 입력하거나 선택하세요"); doSearch(fridgeSel.join(" ") + " 레시피"); showView("search"); };
}
function renderEat() {
  const v = $("#view-eat"); if (!v) return;
  const seed = +(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  const sug = seededShuffle(SUGGEST, seed).slice(0, 12);
  const situations = EAT_GROUPS.map(g => `<div class="eat-glabel">${g.icon} ${g.title}</div><div class="history">${g.items.map(it => `<span class="chip" data-eat="${esc(it.q)}">${esc(it.label)}</span>`).join("")}</div>`).join("");
  const catBody = `<div class="history">${CATEGORIES.map(c => `<span class="chip" data-cat="${esc(c.q)}">${esc(c.label)}</span>`).join("")}${sug.map(s => `<span class="chip" data-cat="${esc(s + " 레시피")}">${esc(s)}</span>`).join("")}</div>`;
  const acc = (t, body) => `<div class="acc"><div class="acc-head"><span>${t}</span><span class="acc-chev">▾</span></div><div class="acc-body">${body}</div></div>`;
  v.innerHTML = `<h1 class="view-title">🍽 오늘 뭐 먹지?</h1><p class="muted">원하는 방식을 열어서 골라보세요.</p>`
    + acc("🍽 상황별", situations)
    + acc("🧊 재료로 · 냉장고 파먹기", `<div id="fridgeBlock"></div>`)
    + acc("📂 카테고리", catBody);
  v.querySelectorAll(".acc-head").forEach(h => h.onclick = () => h.parentElement.classList.toggle("open"));
  v.querySelectorAll("[data-eat]").forEach(c => c.onclick = () => { doSearch(c.dataset.eat); showView("search"); });
  v.querySelectorAll("[data-cat]").forEach(c => c.onclick = () => { doSearch(c.dataset.cat); showView("search"); });
  renderFridge();
}

function renderHome() {
  const home = $("#home"); if (!home) return;
  let html = rouletteSectionHtml();
  if (recent.length) html += `<div class="home-block"><h2>🕘 최근 본 레시피</h2><div class="grid" id="recentGrid"></div></div>`;
  html += `<div class="home-block"><h2>🔥 요즘 인기</h2><div class="grid" id="trendGrid"><div class="status"><span class="spinner"></span></div></div></div>`;
  home.innerHTML = html;
  wireRoulette();
  if (recent.length) { const rg = $("#recentGrid"); recent.slice(0, 3).forEach(v => { lastResults.set(v.id, v); rg.appendChild(card(v)); }); }
  loadTrending().then(items => {
    const tg = $("#trendGrid"); if (!tg) return;
    tg.innerHTML = "";
    if (!items.length) { tg.innerHTML = '<p class="muted">인기 영상을 불러오지 못했어요. 검색해 보세요.</p>'; return; }
    items.slice(0, 6).forEach(v => { lastResults.set(v.id, v); tg.appendChild(card(v)); });
  });
}

function showHome() { $("#home").classList.remove("hidden"); renderHome(); }
function hideHome() { const h = $("#home"); if (h) h.classList.add("hidden"); }
function goHome() {
  currentQuery = ""; $("#q").value = ""; $("#results").innerHTML = ""; $("#resultMeta").textContent = "";
  $("#savedTop").classList.add("hidden"); $("#moreBtn").classList.add("hidden"); $("#status").textContent = "";
  showView("search"); showHome();
}

/* ---------- 이미지 카드 공유 + 온보딩 + 평점 ---------- */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); }
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function wrapText(c, text, x, y, maxW, lh) {
  const chars = [...String(text)]; let line = "";
  for (const ch of chars) { const t = line + ch; if (c.measureText(t).width > maxW && line) { c.fillText(line, x, y); y += lh; line = ch; } else line = t; }
  if (line) { c.fillText(line, x, y); y += lh; }
  return y;
}
async function shareRecipeCard(d) {
  try {
    const W = 1080, H = 1350, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#ff8a65"); g.addColorStop(1, "#ff5722");
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const m = 56; c.fillStyle = "#fff"; roundRect(c, m, m, W - 2 * m, H - 2 * m, 40); c.fill();
    c.textBaseline = "top";
    try { const lg = await loadImg("/icon-192.png"); c.drawImage(lg, m + 40, m + 44, 104, 104); } catch {}
    c.fillStyle = "#ff5722"; c.font = "700 40px sans-serif"; c.fillText("레시피튜브", m + 164, m + 76);
    c.fillStyle = "#1c1c1e"; c.font = "800 62px sans-serif";
    let y = wrapText(c, d.dish || "레시피", m + 50, m + 210, W - 2 * m - 100, 74);
    y += 24; c.fillStyle = "#ff5722"; c.font = "700 36px sans-serif"; c.fillText("🧺 재료", m + 50, y); y += 66;
    c.fillStyle = "#333"; c.font = "400 34px sans-serif";
    const ing = (d.ingredients || []).filter(i => i && (i.item || i.amount)).slice(0, 8);
    if (ing.length) ing.forEach(i => { c.fillText("·  " + (i.item || "") + "   " + (i.amount || ""), m + 50, y); y += 52; });
    else c.fillText("영상에서 전체 레시피를 확인하세요", m + 50, y);
    c.fillStyle = "#888"; c.font = "400 28px sans-serif"; c.fillText("레시피튜브 앱에서 영상·전체 레시피 보기", m + 50, H - m - 96);
    c.fillStyle = "#ff5722"; c.font = "600 30px sans-serif"; c.fillText("recipe-blush-ten.vercel.app", m + 50, H - m - 56);
    const blob = await new Promise(r => cv.toBlob(r, "image/png"));
    const url = location.origin + "/?recipe=" + (d.videoId || d._id || "");
    const file = new File([blob], "recipe.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: d.dish || "레시피튜브", text: (d.dish || "레시피") + " — 레시피튜브\n" + url });
    } else {
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (d.dish || "recipe") + ".png"; a.click();
      toast("이미지를 저장했어요 — 공유해보세요");
    }
  } catch (e) { shareRecipe(d); }
}
function showOnboarding() {
  if (store.get("rt_onboarded", false)) return;
  const ov = el("div", "onboard");
  ov.innerHTML = `<div class="ob-card"><div class="ob-emoji">🍳</div><h2>레시피튜브에 오신 걸 환영해요</h2><ul class="ob-list"><li>🔎 요리 이름을 검색하면 <b>성과 좋은 유튜브 영상</b>이 떠요</li><li>🧾 각 영상의 <b>재료·조리법을 AI가 요약</b>해줘요</li><li>⭐ 저장하고 🛒 <b>장보기</b>로 재료까지 담아요</li></ul><button class="ob-start">시작하기</button></div>`;
  document.body.appendChild(ov); pushOverlay();
  ov.querySelector(".ob-start").onclick = () => { store.set("rt_onboarded", true); ov.remove(); history.back(); };
}
function maybeRatePrompt() {
  if (store.get("rt_rated", false)) return;
  const n = store.get("rt_opencount", 0) + 1; store.set("rt_opencount", n);
  if (n !== 3) return;
  setTimeout(() => {
    if (store.get("rt_rated", false)) return;
    const bar = el("div", "rate-bar");
    bar.innerHTML = `<span>앱이 마음에 드세요? ⭐ 평점이 큰 힘이 돼요</span><div class="rb-btns"><button class="r-yes">평점 남기기</button><button class="r-no">나중에</button></div>`;
    document.body.appendChild(bar);
    bar.querySelector(".r-yes").onclick = () => { store.set("rt_rated", true); const u = window.PLAY_URL || ""; if (u) window.open(u, "_blank", "noopener"); else shareText("레시피튜브", "레시피튜브 — 유튜브 요리 레시피 앱", location.origin); bar.remove(); };
    bar.querySelector(".r-no").onclick = () => bar.remove();
  }, 1500);
}

function pushOverlay() { try { history.pushState({ ov: 1 }, ""); } catch {} }
window.addEventListener("popstate", () => {
  const cm = document.getElementById("cookMode");
  if (cm && !cm.classList.contains("hidden")) { stopCook(true); return; }
  const md = document.getElementById("modal");
  if (md && !md.classList.contains("hidden")) { closeModal(true); return; }
  const ob = document.querySelector(".onboard"); if (ob) ob.remove();
});

/* ---------- 초기화 ---------- */
applyTheme(); updateCounts(); renderHistory(); showHome();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
showOnboarding();
{ const p = new URLSearchParams(location.search); if (p.get("recipe")) openRecipe(p.get("recipe")); else if (p.get("q")) doSearch(p.get("q")); }
