
"use strict";

import { ProductSession, productIdFromUrl } from "./services/product_context.js";
import { logActivity } from "./services/activity_service.js";
import { buildAnalytics } from "./services/analytics_service.js";

const API_URL = "http://127.0.0.1:8000";

const $ = (selector) => document.querySelector(selector);

const el = (tag, className = "", value = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
};

const COLORS = {
  positive: "#16a34a",
  neutral: "#eab308",
  negative: "#dc2626"
};

const SENTIMENT_LABELS = {
  positive: "Tích cực",
  neutral: "Trung lập",
  negative: "Tiêu cực"
};

const CATEGORY_LABELS = {
  Service: "Dịch vụ",
  General: "Chất lượng chung",
  Design: "Thiết kế",
  Material: "Chất liệu",
  Price: "Giá cả",
  PERFORMANCE: "Hiệu năng",
  CAMERA: "Camera",
  BATTERY: "Pin",
  SCREEN: "Màn hình",
  STORAGE: "Bộ nhớ",
  FEATURES: "Tính năng",
  "SER&ACC": "Dịch vụ"
};

const categoryName = (value) =>
  CATEGORY_LABELS[value] || value || "Khác";

let selectedLimit = 100;
let selectedRating = "all";
let collectedReviews = [];
let latestBatchResult = null;
let latestAnalytics = null;
let currentProductId = null;
let currentRatingSummary = null;
let isBusy = false;
const session = new ProductSession();
let navigationTicket = 0;
let productLoadTicket = 0;
let productLoading = false;
let loadedProductRevision = -1;
const pendingCollections = new Map();

const ERROR_LABELS = {
  product_changed: "Sản phẩm đã thay đổi. Hãy phân tích lại sản phẩm hiện tại.",
  product_page_loading: "Trang sản phẩm đang tải. Chờ trang tải xong rồi thử lại.",
  all_rating_filter_not_found: "Không tìm thấy bộ lọc tất cả đánh giá trên trang Shopee.",
  first_page_not_confirmed: "Không chuyển được về trang bình luận đầu tiên. Hãy thử lại.",
  review_section_not_found: "Chưa tìm thấy phần đánh giá. Hãy chờ trang tải xong rồi thử lại."
};

const STOP_LABELS = {
  target_reached: "đủ số lượng đã chọn",
  end_of_reviews: "đã đến trang cuối",
  pagination_end_or_unavailable: "không còn nút trang sau hoặc không đọc được phân trang",
  page_change_not_confirmed: "trang bình luận không tải tiếp",
  repeated_page: "trang bình luận bị lặp",
  no_review_cards: "không tìm thấy thẻ bình luận",
  two_pages_without_new_reviews: "hai trang liên tiếp không có nội dung mới",
  max_pages_reached: "đạt giới hạn số trang",
  first_page_not_confirmed: "không chuyển được về trang đầu"
};

function stopCurrentRun(reason = "user_cancelled") {
  const run = session.run;
  if (!run) return;
  session.cancel();
  pendingCollections.get(run.runId)?.resolve({ ok: false, error: "collection_cancelled" });
  void chrome.runtime.sendMessage({
    type: "CANCEL_SHOPEE_COLLECTION", tabId: run.tabId, runId: run.runId
  }).catch(() => {});
  void logActivity("run_cancelled", run, { reason }, performance.now() - run.started);
  setBusy(false);
}

function resetProductView(productId) {
  collectedReviews = [];
  latestBatchResult = null;
  latestAnalytics = null;
  currentProductId = productId;
  currentRatingSummary = null;
  loadedProductRevision = -1;
  selectedRating = "all";
  $("#dashboard").hidden = true;
  $("#collectionInfo").hidden = true;
  $("#collectionInfo").textContent = "";
  $("#progressWrap").hidden = true;
  $("#progressFill").style.width = "0%";
  $("#reviewList").replaceChildren();
  $("#ratingFilters").replaceChildren();
  $("#results").replaceChildren();
  $("#review").value = "";
  $("#productName").textContent = productId
    ? "Đang tải sản phẩm hiện tại..." : "Mở trang sản phẩm Shopee để bắt đầu";
  $("#productPrice").textContent = "";
  $("#productMeta").textContent = productId ? "Đang đọc thông tin trên trang..." : "";
  setBusy(false);
}

async function loadProduct(context, revision) {
  const ticket = ++productLoadTicket;
  productLoading = true;
  const isCurrent = () => ticket === productLoadTicket && session.revision === revision;
  try {
    // Shopee may update the URL before its product DOM has finished loading.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, 700));
      if (!isCurrent()) return;
      try {
        const data = await collect("COLLECT_SHOPEE_PRODUCT", {}, context);
        if (!isCurrent()) return;
        const product = data.product || data;
        if (product.product_id !== context.productId || !product.name) continue;
        showProduct(product);
        return;
      } catch (error) {
        if (!isCurrent()) return;
        if (attempt === 4) throw error;
      }
    }
    throw new Error("Chưa đọc được thông tin sản phẩm.");
  } catch (error) {
    if (isCurrent()) {
      $("#productName").textContent = "Sản phẩm Shopee hiện tại";
      $("#productMeta").textContent = "Chờ trang tải xong rồi nhấn Phân tích.";
    }
  } finally {
    if (isCurrent()) productLoading = false;
  }
}

async function syncActiveProduct(refresh = false) {
  const ticket = ++navigationTicket;
  let tab;
  try { tab = await activeTab(); } catch { tab = null; }
  if (ticket !== navigationTicket) return;
  const nextProductId = productIdFromUrl(tab?.url);
  if (ticket !== navigationTicket) return;
  const nextKey = `${tab?.id ?? "none"}:${nextProductId ?? "none"}`;
  const changed = nextKey !== session.context?.key;
  if (changed) stopCurrentRun("product_changed");
  session.update(tab);
  if (changed) {
    productLoadTicket++;
    productLoading = false;
    resetProductView(nextProductId);
    setStatus(nextProductId ? "Đã chuyển sang sản phẩm hiện tại." : "Hãy mở một trang sản phẩm Shopee.");
    void logActivity("product_changed", session.context, { tab_id: tab?.id ?? null });
  }
  if (nextProductId && (changed || refresh || loadedProductRevision !== session.revision) &&
      !isBusy && !productLoading) {
    await loadProduct({ ...session.context }, session.revision);
  }
}

async function assertCurrentRun(run) {
  await syncActiveProduct();
  if (!session.isCurrent(run)) throw new DOMException("Sản phẩm đã thay đổi hoặc tác vụ đã dừng.", "AbortError");
}

function setStatus(message, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}

function showLogStatus(status) {
  if (!status?.mode) return;
  const message = $("#logStatus");
  message.hidden = status.mode === 'available' || status.mode === 'unknown';
  if (status.mode === 'backend_update_required') {
    message.textContent = "Log đang lưu tạm trong Extension. Khởi động lại Backend để ghi log vào file.";
  } else if (status.mode === 'storage_unavailable') {
    message.textContent = "Chưa lưu được log. Hãy tải lại Extension để thử lại.";
  } else {
    message.textContent = "Log đang lưu tạm trong Extension; sẽ ghi vào file khi Backend kết nối lại.";
  }
}

async function refreshLogStatus(force = false) {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ABSA_FLUSH_LOGS', force });
    showLogStatus(result?.status);
  } catch { /* A reload can briefly disconnect the worker. */ }
}

function setBusy(busy) {
  isBusy = busy;

  $("#runAnalysis").disabled = busy;
  $("#analyze").disabled = busy;
  $("#fromPage").disabled = busy;
  $("#cancelAnalysis").hidden = !busy;

  document.querySelectorAll(".choice").forEach(button => {
    button.disabled = busy;
  });

  $("#runAnalysis").textContent = busy
    ? "Đang xử lý, vui lòng chờ..."
    : "Phân tích đánh giá sản phẩm";
}

function updateProgress(processed, total, label) {
  $("#progressWrap").hidden = false;

  const pct = total > 0
    ? Math.max(0, Math.min(100, processed / total * 100))
    : 0;

  $("#progressFill").style.width = `${pct}%`;
  $("#progressText").textContent = label;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("Không tìm thấy tab Chrome đang mở.");
  }

  return tab;
}

async function collect(type, extra = {}, context = session.context) {
  const tab = context?.tabId ? await chrome.tabs.get(context.tabId) : await activeTab();
  context?.signal?.throwIfAborted();

  if (
    !/^https:\/\/(?:[^/]+\.)?shopee\.vn\//i.test(tab.url || "")
  ) {
    throw new Error(
      "Hãy mở một trang sản phẩm trên shopee.vn trước."
    );
  }

  let pending;
  if (type === 'COLLECT_SHOPEE_REVIEWS') {
    pending = {};
    pending.promise = new Promise(resolve => { pending.resolve = resolve; });
    pendingCollections.set(extra.runId, pending);
  }
  let data;
  try {
    const response = await chrome.runtime.sendMessage({
      type,
      tabId: tab.id,
      productId: context?.productId,
      ...extra
    });
    data = response?.started && pending ? await pending.promise : response;
  } finally {
    if (pending) pendingCollections.delete(extra.runId);
  }

  if (!data?.ok) {
    throw new Error(
      data?.error || "Không nhận được dữ liệu từ Shopee."
    );
  }

  return data;
}

function showProduct(p) {
  if (!p) return;

  $("#productName").textContent =
    p.name || "Sản phẩm Shopee";

  $("#productPrice").textContent =
    p.price_text ||
    (p.price != null ? String(p.price) : "");

  $("#productMeta").textContent = [
    p.rating != null ? `★ ${p.rating}` : null,
    p.review_count != null
      ? `${p.review_count} đánh giá trên trang`
      : null
  ].filter(Boolean).join(" · ") ||
    "Đang phân tích bình luận người mua";

  currentProductId =
    p.product_id ||
    (
      p.shop_id && p.item_id
        ? `${p.shop_id}.${p.item_id}`
        : currentProductId
    );
  if (currentProductId === session.context?.productId) loadedProductRevision = session.revision;
  updateRatingSummary({
    ...p.rating_summary,
    average: p.rating_summary?.average ?? p.rating ?? null,
    total: p.rating_summary?.total ?? p.review_count ?? null
  });
}

function updateRatingSummary(summary) {
  if (!summary) return;
  const previous = currentRatingSummary;
  currentRatingSummary = {
    source: 'shopee',
    average: summary.average ?? previous?.average ?? null,
    total: summary.total_approximate && previous?.total != null && !previous.total_approximate
      ? previous.total : summary.total ?? previous?.total ?? null,
    counts: Object.fromEntries([1, 2, 3, 4, 5].map(star =>
      [star, summary.counts?.[star] ?? previous?.counts?.[star] ?? null]
    )),
    approximate: summary.distribution_available ? Boolean(summary.approximate)
      : Boolean(summary.approximate || previous?.approximate),
    total_approximate: summary.total_approximate && previous?.total != null && !previous.total_approximate
      ? false : summary.total_approximate ?? previous?.total_approximate ?? false
  };
}

function drawBar(host, label, count, total, color) {
  const row = el("div", "bar-row");
  row.append(el("span", "", label));

  const track = el("div", "track");
  const fill = el("div", "fill");

  fill.style.width =
    `${total ? count / total * 100 : 0}%`;
  fill.style.background = color;

  track.append(fill);
  row.append(
    track,
    el("span", "", count == null ? "—" : String(count))
  );

  host.append(row);
}

function renderDashboard(a) {
  $("#dashboard").hidden = false;
  $("#aspectCount").textContent =
    `${a.totalAspects} aspect`;

  // Tổng quan cảm xúc
  const sentiments = $("#sentimentCards");
  sentiments.replaceChildren();

  for (const key of [
    "positive", "neutral", "negative"
  ]) {
    const card = el("div", `sentiment-box ${key}`);
    const n = a.sentiments?.[key] || 0;

    const pct = a.totalAspects
      ? (100 * n / a.totalAspects).toFixed(1)
      : "0.0";

    card.append(
      el("strong", "", `${pct}%`),
      el("span", "", SENTIMENT_LABELS[key])
    );

    sentiments.append(card);
  }

  // Phân bố rating Shopee
  const counts = a.ratings?.counts || {};
  const known = a.ratings?.known || 0;

  $("#ratingSample").textContent =
    a.ratings?.total == null ? "Số liệu Shopee" :
      `${a.ratings.totalApproximate ? '≈ ' : ''}${a.ratings.total} đánh giá`;

  $("#averageRating").textContent =
    a.ratings?.average == null
      ? "—"
      : Number(a.ratings.average).toFixed(2);

  const bars = $("#ratingBars");
  bars.replaceChildren();

  if (Object.values(counts).some(count => count !== null)) {
    for (const star of [5, 4, 3, 2, 1]) {
      drawBar(bars, `${star} sao`, counts[star] ?? null, known, "#f97316");
    }
  } else {
    bars.append(el("p", "empty", "Chưa đọc được phân bố sao từ Shopee."));
  }
  $("#ratingNote").textContent = "Số liệu Shopee, gồm cả đánh giá chỉ có sao." +
    (a.ratings?.approximate ? " Số có k/m được quy đổi gần đúng." : "");

  // Biểu đồ category
  const categories = $("#categoryBars");
  categories.replaceChildren();

  for (const cat of a.categories || []) {
    const item = el("div", "category-item");
    const head = el("div", "category-head");

    head.append(
      el("span", "", categoryName(cat.name)),
      el("span", "", `${cat.total} lượt`)
    );

    const stack = el("div", "stack");

    for (const key of [
      "positive", "neutral", "negative"
    ]) {
      if (!cat[key]) continue;

      const segment = el("div");

      segment.style.width =
        `${cat.total ? 100 * cat[key] / cat.total : 0}%`;

      segment.style.background = COLORS[key];
      stack.append(segment);
    }

    const legend = el("div", "legend");

    legend.append(
      el("span", "good", `${cat.positive} tích cực`),
      el("span", "mixed", `${cat.neutral} trung lập`),
      el("span", "bad", `${cat.negative} tiêu cực`)
    );

    item.append(head, stack, legend);
    categories.append(item);
  }

  if (!a.categories?.length) {
    categories.append(
      el("p", "empty", "Không có khía cạnh để thống kê.")
    );
  }

  renderFilters();
  renderReviews();
}

function aspectsForResult(result) {
  // Ưu tiên kết quả đã gộp; mảng rỗng vẫn hợp lệ, không lấy lại dự đoán thô.
  if (Array.isArray(result?.aspects_merged)) {
    return result.aspects_merged;
  }

  return Array.isArray(result?.aspects)
    ? result.aspects
    : [];
}

function renderFilters() {
  const filters = $("#ratingFilters");
  filters.replaceChildren();

  const options = [
    ["all", "Tất cả"],
    ["5", "5 sao"],
    ["4", "4 sao"],
    ["3", "3 sao"],
    ["2", "2 sao"],
    ["1", "1 sao"],
    ["unknown", "Chưa rõ"]
  ];

  for (const [value, label] of options) {
    const button = el(
      "button",
      `filter ${selectedRating === value ? "active" : ""}`,
      label
    );

    button.type = "button";

    button.setAttribute(
      "aria-pressed",
      String(selectedRating === value)
    );

    button.addEventListener("click", () => {
      selectedRating = value;
      renderFilters();
      renderReviews();
    });

    filters.append(button);
  }
}

function renderReviews() {
  const list = $("#reviewList");
  list.replaceChildren();

  const results = latestBatchResult?.results || [];

  // Ghép kết quả dự đoán với nội dung bình luận
  const byText = new Map();

  for (const result of results) {
    const key = result.text || "";

    if (!byText.has(key)) {
      byText.set(key, []);
    }

    byText.get(key).push(result);
  }

  const filtered = collectedReviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => {
      if (selectedRating === "all") return true;

      if (selectedRating === "unknown") {
        return review.rating == null;
      }

      return Number(review.rating) ===
        Number(selectedRating);
    });

  $("#reviewCount").textContent =
    `${filtered.length}/${collectedReviews.length}`;

  if (!filtered.length) {
    list.append(
      el("p", "empty", "Không có bình luận phù hợp.")
    );
    return;
  }

  // Xử lý cả trường hợp nhiều bình luận trùng văn bản
  const seen = new Map();

  // Ghép theo thứ tự xuất hiện trên toàn bộ danh sách trước khi lọc sao,
  // để các bình luận trùng nội dung không bị đổi kết quả khi đổi bộ lọc.
  const predictionAtIndex = collectedReviews.map(review => {
    const key = review.text || "";
    const index = seen.get(key) || 0;

    seen.set(key, index + 1);

    return byText.get(key)?.[index] || null;
  });

  for (const { review, index } of filtered) {
    const card = el("article", "review-card");
    const head = el("div", "review-head");

    head.append(
      el("strong", "", `Bình luận ${index + 1}`)
    );

    head.append(
      el(
        "span",
        "rating-pill",
        review.rating == null
          ? "Chưa rõ sao"
          : `${review.rating} ★`
      )
    );

    card.append(
      head,
      el(
        "p",
        "",
        review.text || "(Không có nội dung)"
      )
    );

    const tags = el("div", "tags");

    for (const aspect of aspectsForResult(
      predictionAtIndex[index]
    )) {
      const key = String(
        aspect.sentiment || "neutral"
      ).toLowerCase();

      tags.append(
        el(
          "span",
          `tag ${key}`,
          `${categoryName(aspect.category)} · ` +
          `${SENTIMENT_LABELS[key] || key}`
        )
      );
    }

    if (tags.childNodes.length) {
      card.append(tags);
    }

    list.append(card);
  }
}

async function run() {
  if (isBusy) return;
  await syncActiveProduct();
  if (isBusy) return;
  if (!session.context?.productId) {
    setStatus("Hãy mở một trang sản phẩm Shopee trước.", true);
    return;
  }
  const run = session.begin();
  run.started = performance.now();
  const limit = selectedLimit;
  setBusy(true);
  void logActivity("run_started", run, { limit });

  collectedReviews = [];
  latestBatchResult = null;
  latestAnalytics = null;
  currentProductId = run.productId;
  selectedRating = "all";

  $("#dashboard").hidden = true;
  $("#collectionInfo").hidden = true;

  updateProgress(0, 100, "Đang chuẩn bị...");

  try {
    // Lấy thông tin sản phẩm.
    // Nếu thất bại vẫn cho phép thu thập bình luận.
    try {
      const productData = await collect(
        "COLLECT_SHOPEE_PRODUCT", {}, run
      );
      await assertCurrentRun(run);
      showProduct(
        productData.product || productData
      );
    } catch (error) {
      if (!session.isCurrent(run)) throw error;
      if (error.message === "product_page_loading" || error.message === "product_changed") throw error;
      console.warn(
        "Product metadata unavailable:",
        error
      );
    }
    await assertCurrentRun(run);
    setStatus(
      limit === "all" ? "Đang lấy tất cả bình luận có nội dung..."
        : `Đang thu thập tối đa ${limit} bình luận...`
    );
    const collectionStarted = performance.now();
    void logActivity("collection_started", run, { limit });
    const data = await collect(
      "COLLECT_SHOPEE_REVIEWS",
      { limit, runId: run.runId }, run
    );
    await assertCurrentRun(run);
    if (data.product_id !== run.productId) throw new Error("product_changed");
    void logActivity("collection_completed", run, {
      collected: data.reviews?.length || 0,
      pages: data.stats?.pages_checked || 0,
      stop_reason: data.stats?.stop_reason || "unknown",
      skipped_without_comment: data.stats?.skipped_without_comment || 0
    }, performance.now() - collectionStarted);
    collectedReviews = Array.isArray(data.reviews)
      ? data.reviews
      : [];

    currentProductId =
      data.product_id || currentProductId;
    updateRatingSummary(data.rating_summary);

    const collectionInfo = $("#collectionInfo");
    collectionInfo.hidden = false;

    collectionInfo.textContent =
      (limit === "all" ? `Đã lấy ${collectedReviews.length} bình luận có nội dung`
        : `Đã lấy ${collectedReviews.length}/${limit} bình luận có nội dung`) +
      ` · ${data.stats?.pages_checked ?? "?"} trang · ` +
      (STOP_LABELS[data.stats?.stop_reason] || data.stats?.stop_reason || "đã dừng");

    if (!collectedReviews.length) {
      latestBatchResult = { results: [], submitted: 0, completed: 0 };
      latestAnalytics = buildAnalytics(latestBatchResult, [], currentRatingSummary);
      renderDashboard(latestAnalytics);
      setStatus("Chưa lấy được bình luận có nội dung để phân tích. Số sao hiển thị theo Shopee.");
      updateProgress(0, 0, "Không có lời bình để gửi vào mô hình");
      void logActivity("run_completed", run, { collected: 0, completed: 0 }, performance.now() - run.started);
      return;
    }

    // Phân tích ABSA bằng Backend hiện tại
    const { analyzeReviewBatch } =
      await import("./services/batch_service.js");

    await assertCurrentRun(run);
    const analysisStarted = performance.now();
    void logActivity("analysis_started", run, { reviews: collectedReviews.length });
    setStatus(
      `Đang phân tích ${collectedReviews.length} bình luận...`
    );

    updateProgress(
      0,
      collectedReviews.length,
      "Đang chạy mô hình ABSA..."
    );

    const batchResult = await analyzeReviewBatch(
      collectedReviews,
      currentProductId,
      (p) => {
        if (!session.isCurrent(run)) return;
        updateProgress(
          p.processed,
          p.total,
          `Đã xử lý ${p.processed}/${p.total} bình luận`
        );
      },
      { signal: run.signal, runId: run.runId }
    );
    await assertCurrentRun(run);
    latestBatchResult = batchResult;
    void logActivity("analysis_completed", run, {
      completed: batchResult.completed, failed: batchResult.failed,
      stopped_early: batchResult.stopped_early
    }, performance.now() - analysisStarted);
    latestAnalytics = buildAnalytics(
      latestBatchResult,
      collectedReviews,
      currentRatingSummary
    );

    renderDashboard(latestAnalytics);

    if (latestBatchResult.stopped_early) {
      setStatus(
        `Đã phân tích ${latestBatchResult.completed} ` +
        `bình luận; dừng sớm: ` +
        `${latestBatchResult.error || "lỗi không rõ"}`,
        true
      );
    } else {
      setStatus(
        `Hoàn tất · ${latestBatchResult.completed}/` +
        `${collectedReviews.length} bình luận ` +
        `phân tích thành công.`
      );
    }

    updateProgress(
      latestBatchResult.submitted,
      collectedReviews.length,
      "Đã hoàn thành phân tích"
    );
    void logActivity("run_completed", run, {
      collected: collectedReviews.length, completed: batchResult.completed,
      stopped_early: batchResult.stopped_early
    }, performance.now() - run.started);

  } catch (error) {
    if (!session.isCurrent(run)) return;
    void logActivity("run_failed", run, { error_type: error.name, reason: error.message.slice(0, 150) },
      performance.now() - run.started);
    setStatus(`Lỗi: ${ERROR_LABELS[error.message] || error.message}`, true);
    $("#progressWrap").hidden = true;
  } finally {
    if (session.run === run) {
      session.run = null;
      setBusy(false);
    }
  }
}

async function checkBackend() {
  try {
    const response = await fetch(`${API_URL}/health`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    void refreshLogStatus(true);

    $("#connection").textContent = data.ready
      ? "Sẵn sàng"
      : "Chưa sẵn sàng";

    $("#connection").className =
      `connection ${data.ready ? "ok" : "error"}`;

    if (!isBusy) setStatus(
      data.ready
        ? "Mở sản phẩm Shopee và nhấn Phân tích."
        : (data.error || "Mô hình chưa sẵn sàng."),
      !data.ready
    );

  } catch {
    $("#connection").textContent = "Mất kết nối";
    $("#connection").className = "connection error";

    if (!isBusy) setStatus(
      "Không kết nối được FastAPI tại 127.0.0.1:8000.",
      true
    );
  }
}

// Chọn giới hạn bình luận
document.querySelectorAll(".choice").forEach(
  button => button.addEventListener("click", () => {
    if (isBusy) return;

    selectedLimit = button.dataset.limit === "all" ? "all" : Number(button.dataset.limit);
    $("#reviewLimit").value = String(selectedLimit);

    document.querySelectorAll(".choice").forEach(
      other => {
        const active = other === button;

        other.classList.toggle("active", active);

        other.setAttribute(
          "aria-pressed",
          String(active)
        );
      }
    );
  })
);

$("#runAnalysis").addEventListener("click", run);
$("#cancelAnalysis").addEventListener("click", () => {
  stopCurrentRun();
  $("#progressWrap").hidden = true;
  setStatus("Đã dừng. Yêu cầu model đã gửi có thể hoàn tất ở Backend; kết quả sẽ được bỏ qua.");
});

// Lấy văn bản người dùng chọn
$("#fromPage").addEventListener("click", async () => {
  const revision = session.revision;
  try {
    const tab = await activeTab();

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() || ""
    });
    await syncActiveProduct();
    if (revision !== session.revision) return;

    const text = injected?.[0]?.result?.trim();

    if (!text) {
      throw new Error(
        "Hãy bôi đen một đoạn trên trang trước."
      );
    }

    $("#review").value = text.slice(0, 3000);
    setStatus("Đã lấy văn bản được chọn.");

  } catch (error) {
    if (revision !== session.revision) return;
    setStatus(`Lỗi: ${error.message}`, true);
  }
});

// Phân tích một bình luận riêng
$("#analyze").addEventListener("click", async () => {
  if (isBusy) return;
  await syncActiveProduct();
  if (isBusy) return;
  const text = $("#review").value.trim();

  if (!text) {
    setStatus("Hãy nhập một bình luận.", true);
    return;
  }

  const run = session.begin();
  run.started = performance.now();
  setBusy(true);
  void logActivity("manual_analysis_started", run, { text_chars: text.length });
  $("#results").replaceChildren();

  try {
    const response = await fetch(`${API_URL}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        source: "unified",
        run_id: run.runId,
        product_id: run.productId || null
      }),
      signal: run.signal
    });

    const data = await response.json();
    await assertCurrentRun(run);

    if (!response.ok) {
      throw new Error(
        JSON.stringify(data.detail || data)
      );
    }

    const aspects = aspectsForResult(data);

    for (const aspect of aspects) {
      const key = String(
        aspect.sentiment || "neutral"
      ).toLowerCase();

      $("#results").append(
        el(
          "span",
          `tag ${key}`,
          `${aspect.aspect || ""} · ` +
          `${categoryName(aspect.category)} · ` +
          `${SENTIMENT_LABELS[key] || key}`
        )
      );
    }

    if (!aspects.length) {
      $("#results").append(
        el(
          "p",
          "empty",
          "Chưa phát hiện khía cạnh rõ ràng."
        )
      );
    }

    setStatus(
      `Đã tìm thấy ${aspects.length} aspect.`
    );
    void logActivity("manual_analysis_completed", run, { aspects: aspects.length },
      performance.now() - run.started);

  } catch (error) {
    if (!session.isCurrent(run)) return;
    void logActivity("manual_analysis_failed", run, { error_type: error.name },
      performance.now() - run.started);
    setStatus(`Lỗi ABSA: ${error.message}`, true);
  } finally {
    if (session.run === run) {
      session.run = null;
      setBusy(false);
    }
  }
});

chrome.tabs.onActivated.addListener(() => { void syncActiveProduct(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === session.context?.tabId && (change.url || change.status === "complete")) {
    void syncActiveProduct(change.status === "complete");
  }
});
chrome.windows.onFocusChanged.addListener(() => { void syncActiveProduct(); });
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'ABSA_LOG_STATUS') {
    showLogStatus(message.status);
    return;
  }
  if (message?.type === 'ABSA_COLLECTION_DONE') {
    const pending = pendingCollections.get(message.run_id);
    if (pending && message.product_id === session.run?.productId) {
      pending.resolve(message.data);
    }
    return;
  }
  const run = session.run;
  if (message?.type !== "ABSA_COLLECTION_PROGRESS" || !run ||
      message.run_id !== run.runId || message.product_id !== run.productId) return;
  const stats = message.stats || {};
  updateProgress(stats.collected || 0, selectedLimit === "all" ? 0 : selectedLimit,
    `Đã lấy ${stats.collected || 0} bình luận · ${stats.page || 0} trang`);
});
// Also catches SPA navigation when Chrome does not emit a load completion.
setInterval(() => { void syncActiveProduct(); }, 1000);
setInterval(() => { void refreshLogStatus(); }, 30000);
void syncActiveProduct();
void checkBackend();
