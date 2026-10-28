
"use strict";

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
let isBusy = false;

function setStatus(message, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}

function setBusy(busy) {
  isBusy = busy;

  $("#runAnalysis").disabled = busy;
  $("#analyze").disabled = busy;
  $("#fromPage").disabled = busy;

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

async function collect(type, extra = {}) {
  const tab = await activeTab();

  if (
    !/^https:\/\/(?:[^/]+\.)?shopee\.vn\//i.test(tab.url || "")
  ) {
    throw new Error(
      "Hãy mở một trang sản phẩm trên shopee.vn trước."
    );
  }

  const data = await chrome.runtime.sendMessage({
    type,
    tabId: tab.id,
    ...extra
  });

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
    el("span", "", String(count || 0))
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
    `${a.collected} bình luận`;

  $("#averageRating").textContent =
    a.ratings?.average == null
      ? "—"
      : Number(a.ratings.average).toFixed(2);

  const bars = $("#ratingBars");
  bars.replaceChildren();

  for (const star of [5, 4, 3, 2, 1]) {
    drawBar(
      bars,
      `${star} sao`,
      counts[star] || 0,
      known,
      "#f97316"
    );
  }

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

  setBusy(true);

  collectedReviews = [];
  latestBatchResult = null;
  latestAnalytics = null;
  currentProductId = null;
  selectedRating = "all";

  $("#dashboard").hidden = true;
  $("#collectionInfo").hidden = true;

  updateProgress(0, 100, "Đang chuẩn bị...");

  try {
    // Lấy thông tin sản phẩm.
    // Nếu thất bại vẫn cho phép thu thập bình luận.
    try {
      const productData = await collect(
        "COLLECT_SHOPEE_PRODUCT"
      );

      showProduct(
        productData.product || productData
      );
    } catch (error) {
      console.warn(
        "Product metadata unavailable:",
        error
      );
    }

    setStatus(
      `Đang thu thập tối đa ${selectedLimit} bình luận...`
    );

    const data = await collect(
      "COLLECT_SHOPEE_REVIEWS",
      { limit: selectedLimit }
    );

    collectedReviews = Array.isArray(data.reviews)
      ? data.reviews
      : [];

    currentProductId =
      data.product_id || currentProductId;

    if (!collectedReviews.length) {
      throw new Error(
        "Không thu thập được bình luận nào."
      );
    }

    const collectionInfo = $("#collectionInfo");
    collectionInfo.hidden = false;

    collectionInfo.textContent =
      `Đã lấy ${collectedReviews.length}/${selectedLimit} ` +
      `bình luận · ${data.stats?.pages_checked ?? "?"} trang`;

    // Phân tích ABSA bằng Backend hiện tại
    const { analyzeReviewBatch } =
      await import("./services/batch_service.js");

    const { buildAnalytics } =
      await import("./services/analytics_service.js");

    setStatus(
      `Đang phân tích ${collectedReviews.length} bình luận...`
    );

    updateProgress(
      0,
      collectedReviews.length,
      "Đang chạy mô hình ABSA..."
    );

    latestBatchResult = await analyzeReviewBatch(
      collectedReviews,
      currentProductId,
      (p) => {
        updateProgress(
          p.processed,
          p.total,
          `Đã xử lý ${p.processed}/${p.total} bình luận`
        );
      }
    );

    latestAnalytics = buildAnalytics(
      latestBatchResult,
      collectedReviews
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

  } catch (error) {
    setStatus(`Lỗi: ${error.message}`, true);
    $("#progressWrap").hidden = true;
  } finally {
    setBusy(false);
  }
}

async function checkBackend() {
  try {
    const response = await fetch(`${API_URL}/health`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    $("#connection").textContent = data.ready
      ? "Sẵn sàng"
      : "Chưa sẵn sàng";

    $("#connection").className =
      `connection ${data.ready ? "ok" : "error"}`;

    setStatus(
      data.ready
        ? "Mở sản phẩm Shopee và nhấn Phân tích."
        : (data.error || "Mô hình chưa sẵn sàng."),
      !data.ready
    );

  } catch {
    $("#connection").textContent = "Mất kết nối";
    $("#connection").className = "connection error";

    setStatus(
      "Không kết nối được FastAPI tại 127.0.0.1:8000.",
      true
    );
  }
}

// Chọn giới hạn bình luận
document.querySelectorAll(".choice").forEach(
  button => button.addEventListener("click", () => {
    if (isBusy) return;

    selectedLimit = Number(button.dataset.limit);
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

// Lấy văn bản người dùng chọn
$("#fromPage").addEventListener("click", async () => {
  try {
    const tab = await activeTab();

    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() || ""
    });

    const text = injected?.[0]?.result?.trim();

    if (!text) {
      throw new Error(
        "Hãy bôi đen một đoạn trên trang trước."
      );
    }

    $("#review").value = text.slice(0, 3000);
    setStatus("Đã lấy văn bản được chọn.");

  } catch (error) {
    setStatus(`Lỗi: ${error.message}`, true);
  }
});

// Phân tích một bình luận riêng
$("#analyze").addEventListener("click", async () => {
  const text = $("#review").value.trim();

  if (!text) {
    setStatus("Hãy nhập một bình luận.", true);
    return;
  }

  setBusy(true);
  $("#results").replaceChildren();

  try {
    const response = await fetch(`${API_URL}/predict`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        source: "unified"
      })
    });

    const data = await response.json();

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

  } catch (error) {
    setStatus(`Lỗi ABSA: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});

checkBackend();
