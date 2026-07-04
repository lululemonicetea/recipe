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
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach(t => t.onclick = () => showView(t.dataset.view));
$("#brandHome").onclick = () => showView("search");

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
    right.innerHTML = '<div class="mini-loading"><span class="spinner"></span><span>레시피 불러오는 중…</span></div>';
    row.appendChild(left);
    row.appendChild(right);
    grid.appendChild(row);
    loadInlineRecipe(v.id, right);
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

async function openRecipe(id) {
  const v = lastResults.get(id);
  $("#modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("#modalBody").innerHTML = '<div style="text-align:center;padding:50px"><span class="spinner"></span><p class="muted">영상에서 재료·조리법을 정리하고 있어요…</p></div>';
  try {
    const res = await fetch(`/api/summarize?videoId=${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "요약 실패");
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
  const badge = d.source === "ai" ? '<span class="pill ai">AI 요약</span>' : '<span class="pill text">설명 기반</span>';
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
      ${ing.length ? `<button class="cta-cart">🛒 재료 장보기 담기</button>` : ""}
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
}

// 저장한 영상: 오른쪽에 레시피 자동 표시
async function loadInlineRecipe(id, container) {
  try {
    const res = await fetch(`/api/summarize?videoId=${id}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "요약 실패");
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

function closeModal() { $("#modal").classList.add("hidden"); document.body.style.overflow = ""; }
$("#modalClose").onclick = closeModal;
$("#modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* ---------- 장보기 ---------- */
function addIngredientsToCart(ing, src, mult) {
  let added = 0;
  ing.forEach(i => {
    const text = `${i.item || ""} ${scaleAmount(i.amount, mult) || ""}`.trim();
    if (!text) return;
    if (cart.some(c => c.text === text)) return;
    cart.push({ id: uid(), text, src: src || "", done: false });
    added++;
  });
  store.set("rt_cart", cart); updateCounts();
  toast(added ? `🛒 ${added}개 재료를 담았어요` : "이미 담겨 있어요");
}
function renderCart() {
  const list = $("#cartList");
  list.innerHTML = "";
  if (cart.length === 0) { list.innerHTML = '<p class="muted">목록이 비어 있어요.</p>'; return; }
  cart.forEach(item => {
    const li = el("li", item.done ? "done" : "");
    li.innerHTML = `
      <input type="checkbox" ${item.done ? "checked" : ""} data-check="${item.id}">
      <label>${esc(item.text)} ${item.src ? `<span class="src">· ${esc(item.src)}</span>` : ""}</label>
      <button class="del" data-del="${item.id}">🗑</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll("[data-check]").forEach(cb => cb.onchange = () => {
    const it = cart.find(c => c.id === cb.dataset.check); if (it) it.done = cb.checked;
    store.set("rt_cart", cart); renderCart();
  });
  list.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
    cart = cart.filter(c => c.id !== b.dataset.del); store.set("rt_cart", cart); updateCounts(); renderCart();
  });
}
$("#cartAddBtn").onclick = () => {
  const v = $("#cartInput").value.trim(); if (!v) return;
  cart.push({ id: uid(), text: v, src: "직접추가", done: false });
  $("#cartInput").value = ""; store.set("rt_cart", cart); updateCounts(); renderCart();
};
$("#cartInput").addEventListener("keydown", e => { if (e.key === "Enter") $("#cartAddBtn").click(); });
$("#cartCopy").onclick = async () => {
  if (cart.length === 0) return toast("목록이 비어 있어요");
  const text = "🛒 장보기 목록\n" + cart.map(c => `${c.done ? "✔" : "▢"} ${c.text}`).join("\n");
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
  history.forEach(h => { const c = el("span", "chip"); c.textContent = h; c.onclick = () => doSearch(h); box.appendChild(c); });
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

/* ---------- 초기화 ---------- */
applyTheme(); updateCounts(); renderHistory();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
