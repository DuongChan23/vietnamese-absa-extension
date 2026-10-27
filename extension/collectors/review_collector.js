
(async () => {
  "use strict";

  // =====================================================
  // 1. CONFIGURATION
  // =====================================================

  const requested = Number(
    document.documentElement.dataset.absaReviewLimit
  );

  delete document.documentElement.dataset.absaReviewLimit;

  const TARGET_REVIEWS = [50, 100, 200].includes(requested)
    ? requested
    : 50;

  const MAX_PAGES = 65;
  const PAGE_WAIT_MS = 10000;

  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  const clean = value =>
    String(value ?? "").replace(/\s+/g, " ").trim();

  const DATE_REGEX =
    /20\d{2}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}/;

  const DATE_REGEX_GLOBAL =
    /20\d{2}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}/g;

  const url = new URL(location.href);

  const productMatch = url.pathname.match(
    /-i\.(\d+)\.(\d+)(?:\/|$)/
  );

  if (
    !/(^|\.)shopee\.vn$/i.test(url.hostname) ||
    !productMatch
  ) {
    return {
      ok: false,
      error: "not_shopee_product_page"
    };
  }

  const productId =
    `${productMatch[1]}.${productMatch[2]}`;

  const reviews = [];
  const seenKeys = new Set();
  const diagnostics = [];

  // =====================================================
  // 2. DOM HELPERS
  // =====================================================

  function visible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = getComputedStyle(element);

    return (
      element.getClientRects().length > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function rawText(element) {
    return String(element?.innerText || "");
  }

  function dateCount(text) {
    return (
      String(text).match(DATE_REGEX_GLOBAL) || []
    ).length;
  }

  function findReviewSection() {
    return [
      ...document.querySelectorAll(
        "h1,h2,h3,h4,div,span"
      )
    ].find(element =>
      visible(element) &&
      element.children.length <= 2 &&
      clean(element.textContent).toUpperCase() ===
        "ĐÁNH GIÁ SẢN PHẨM"
    ) || null;
  }

  // =====================================================
  // 3. EXTRACT COMMENT
  // =====================================================

  const CONTENT_SELECTORS = [
    ".shopee-product-rating__content--original",
    ".shopee-product-rating__content",
    '[data-testid="review-content"]',
    '[data-testid="rating-content"]'
  ];

  function stripSellerReply(value) {
    return String(value ?? "").split(
      /Phản Hồi Của Người Bán|Phản Hồi Từ Người Bán/i
    )[0];
  }

  function extractText(card) {
    // Ưu tiên phần tử nội dung nếu Shopee cung cấp.
    for (const selector of CONTENT_SELECTORS) {
      const element = card.querySelector(selector);

      if (!element || !visible(element)) continue;

      const value = clean(
        stripSellerReply(rawText(element))
      );

      if (
        value.length >= 3 &&
        value.length <= 3000
      ) {
        return value;
      }
    }

    // Fallback cho giao diện Shopee hiện tại.
    const fullText = rawText(card);
    const match = DATE_REGEX.exec(fullText);

    if (!match) return null;

    // Lấy phần văn bản nằm sau ngày đánh giá.
    const afterDate = fullText.slice(
      match.index + match[0].length
    );

    const lines = stripSellerReply(afterDate)
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);

    const content = [];

    for (const originalLine of lines) {
      let line = originalLine;

      // Bỏ thông tin phân loại gắn cùng ngày đăng.
      line = line.replace(
        /^\s*[\|\-]?\s*Phân loại hàng\s*:[^\n]*/i,
        ""
      ).trim();

      if (!line) continue;

      // Phản hồi người bán không phải bình luận
      // của khách hàng.
      if (
        /^(phản hồi của người bán|phản hồi từ người bán|hữu ích|báo cáo|trả lời|shop phản hồi)/i
          .test(line)
      ) {
        break;
      }

      // Bỏ các dòng metadata sản phẩm.
      if (
        /^(phân loại hàng|màu sắc|chất liệu|đúng với mô tả|thiết kế|kích cỡ|size|mát)\s*:/i
          .test(line)
      ) {
        continue;
      }

      if (
        /^\d+:\d{2}$/.test(line) ||
        /^xem thêm$/i.test(line) ||
        /^\d+\s*(thích|hữu ích|lượt thích)$/i.test(line)
      ) {
        continue;
      }

      // Giữ cả bình luận ngắn: "ok", "tốt"...
      if (line.length < 2) continue;

      content.push(line);
    }

    const result = clean(content.join(" "));

    if (
      result.length < 2 ||
      result.length > 3000
    ) {
      return null;
    }

    return result;
  }

  // =====================================================
  // 4. FIND REVIEW CARDS
  //
  // FIX:
  // .d72He7 có thể chỉ chứa tên + ngày đăng.
  // Phải tìm phần tử cha chứa toàn bộ đánh giá,
  // bao gồm phần nội dung bên dưới.
  // =====================================================

  function findReviewCards() {
    const rows = [
      ...document.querySelectorAll(".d72He7")
    ].filter(visible);

    const cards = [];

    for (const row of rows) {
      let current = row.parentElement;
      let selected = null;
      let fallback = null;

      for (
        let depth = 0;
        depth < 10 && current;
        depth++
      ) {
        const text = rawText(current);
        const trimmed = clean(text);
        const timestamps = dateCount(text);

        // Không lấy container bao gồm nhiều review.
        if (timestamps > 1 || trimmed.length > 6000) {
          break;
        }

        if (
          visible(current) &&
          timestamps === 1
        ) {
          if (!fallback) {
            fallback = current;
          }

          // Chỉ nhận thẻ khi tách được nội dung
          // bình luận thực tế.
          const extracted = extractText(current);

          if (
            extracted &&
            extracted.length >= 2 &&
            trimmed.length >= 35
          ) {
            selected = current;
            break;
          }
        }

        current = current.parentElement;
      }

      // Nếu chỉ có metadata thì vẫn giữ fallback
      // để ghi diagnostics, nhưng không thêm review.
      if (selected || fallback) {
        cards.push(selected || fallback);
      }
    }

    // Fallback khi Shopee đổi class .d72He7.
    if (!cards.length) {
      const dateElements = [
        ...document.querySelectorAll(
          "div,span,time"
        )
      ].filter(element => {
        if (!visible(element)) return false;

        const value = clean(element.textContent);

        return (
          value.length < 130 &&
          DATE_REGEX.test(value) &&
          element.children.length <= 1
        );
      });

      for (const element of dateElements) {
        let current = element.parentElement;

        for (
          let depth = 0;
          depth < 10 && current;
          depth++
        ) {
          const text = rawText(current);

          if (
            dateCount(text) > 1 ||
            clean(text).length > 6000
          ) {
            break;
          }

          if (
            visible(current) &&
            dateCount(text) === 1 &&
            current.querySelectorAll(
              "svg.shopee-svg-icon"
            ).length >= 5 &&
            extractText(current)
          ) {
            cards.push(current);
            break;
          }

          current = current.parentElement;
        }
      }
    }

    const unique = [...new Set(cards)];

    // Bỏ phần tử cha chứa một thẻ đánh giá
    // hợp lệ nhỏ hơn.
    const filtered = unique.filter(card =>
      !unique.some(other =>
        other !== card &&
        card.contains(other)
      )
    );

    // Giữ nguyên thứ tự xuất hiện trên Shopee.
    filtered.sort((a, b) => {
      const position = a.compareDocumentPosition(b);

      if (
        position & Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        return -1;
      }

      if (
        position & Node.DOCUMENT_POSITION_PRECEDING
      ) {
        return 1;
      }

      return 0;
    });

    return filtered;
  }

  // =====================================================
  // 5. EXTRACT STAR RATING
  //
  // Không đoán 5 sao chỉ từ màu đỏ.
  // =====================================================

  function starSignature(svg) {
    return [
      ...svg.querySelectorAll(
        "path,polygon,use"
      )
    ].map(element => [
      element.tagName,
      element.getAttribute("d") || "",
      element.getAttribute("points") || "",
      element.getAttribute("href") || "",
      element.getAttribute("xlink:href") || ""
    ].join("|")).join(";");
  }

  function extractRating(card) {
    // Ưu tiên nhãn số sao rõ ràng.
    for (const element of card.querySelectorAll(
      "[aria-label],[title],[data-rating]"
    )) {
      const values = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-rating")
      ];

      for (const value of values) {
        if (!value) continue;

        const label = clean(value);

        const match = label.match(
          /(?:^|\D)([1-5])\s*(?:sao|stars?)(?:\D|$)/i
        );

        if (match) {
          return Number(match[1]);
        }

        if (
          element.getAttribute("data-rating") === value &&
          /^[1-5]$/.test(label)
        ) {
          return Number(label);
        }
      }
    }

    // Dò đúng hàng 5 ngôi sao của đánh giá.
    const rows = [];

    if (card.matches(".d72He7")) {
      rows.push(card);
    }

    rows.push(
      ...card.querySelectorAll(".d72He7")
    );

    for (const row of rows) {
      const icons = [
        ...row.querySelectorAll(
          "svg.shopee-svg-icon"
        )
      ];

      if (icons.length !== 5) continue;

      const shapes = icons.map(starSignature);

      if (!shapes[0] || !shapes.every(Boolean)) {
        continue;
      }

      // Chỉ trả số sao khi có một nhóm biểu tượng
      // đầu giống nhau, tiếp theo là nhóm khác nhau.
      const split = shapes.findIndex(
        value => value !== shapes[0]
      );

      if (
        split >= 1 &&
        split <= 4 &&
        shapes.slice(split).every(
          value => value === shapes[split]
        )
      ) {
        return split;
      }
    }

    // Trường hợp SVG không đủ thông tin.
    return null;
  }

  // =====================================================
  // 6. REVIEW IDENTITY
  // =====================================================

  function extractIdentity(card) {
    const reviewId =
      card.getAttribute("data-rating-id") ||
      card.getAttribute("data-review-id") ||
      card.querySelector("[data-rating-id]")
        ?.getAttribute("data-rating-id") ||
      null;

    const lines = rawText(card)
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);

    const username = clean(
      card.querySelector(
        ".shopee-product-rating__author-name," +
        '[data-testid="review-author"]'
      )?.textContent ||
      lines[0] ||
      ""
    );

    const date =
      rawText(card).match(DATE_REGEX)?.[0] || null;

    return {
      reviewId,
      username,
      date
    };
  }

  function makeKey(identity, text) {
    if (identity.reviewId) {
      return `${productId}|${identity.reviewId}`;
    }

    return [
      productId,
      identity.username,
      identity.date,
      text
    ].join("|");
  }

  // =====================================================
  // 7. PAGE SIGNATURE
  // =====================================================

  function pageSignature() {
    return findReviewCards()
      .map(card => {
        const identity = extractIdentity(card);

        return [
          identity.reviewId || "",
          identity.username,
          identity.date || "",
          clean(rawText(card)).slice(0, 180)
        ].join("|");
      })
      .join("\n");
  }

  // =====================================================
  // 8. COLLECT CURRENT PAGE
  // =====================================================

  function collectCurrentPage(page) {
    const cards = findReviewCards();

    let added = 0;
    let skippedEmpty = 0;
    let skippedDuplicate = 0;
    let unknownRatings = 0;

    const preview = cards.slice(0, 3).map(card => ({
      raw: clean(rawText(card)).slice(0, 250),
      extracted: extractText(card)
    }));

    for (const card of cards) {
      if (reviews.length >= TARGET_REVIEWS) break;

      const text = extractText(card);

      if (!text) {
        skippedEmpty++;
        continue;
      }

      const identity = extractIdentity(card);
      const key = makeKey(identity, text);

      if (seenKeys.has(key)) {
        skippedDuplicate++;
        continue;
      }

      seenKeys.add(key);

      const rating = extractRating(card);

      if (rating === null) {
        unknownRatings++;
      }

      reviews.push({
        review_id: identity.reviewId,
        product_id: productId,
        text,
        rating,
        created_at: identity.date
      });

      added++;
    }

    diagnostics.push({
      page,
      cards_found: cards.length,
      added,
      skipped_empty: skippedEmpty,
      skipped_duplicate: skippedDuplicate,
      rating_unknown: unknownRatings,
      total_collected: reviews.length,
      preview
    });

    return {
      cardsFound: cards.length,
      added
    };
  }

  // =====================================================
  // 9. PAGINATION
  // =====================================================

  function findNextButton() {
    const selectors = [
      ".shopee-icon-button--right",
      '[aria-label="Next"]',
      '[aria-label="Trang sau"]',
      'button[aria-label*="next" i]'
    ];

    for (const selector of selectors) {
      const button = [
        ...document.querySelectorAll(selector)
      ].find(element =>
        visible(element) &&
        !element.disabled &&
        element.getAttribute("aria-disabled") !== "true" &&
        !element.classList.contains(
          "shopee-icon-button--disabled"
        )
      );

      if (button) return button;
    }

    return null;
  }

  async function waitForPageChange(previous) {
    const deadline = Date.now() + PAGE_WAIT_MS;

    while (Date.now() < deadline) {
      await sleep(350);

      const current = pageSignature();

      if (
        current &&
        current !== previous
      ) {
        await sleep(500);
        return true;
      }
    }

    return false;
  }

  // =====================================================
  // 10. RUN COLLECTION
  // =====================================================

  const heading = findReviewSection();

  if (!heading) {
    return {
      ok: false,
      error: "review_section_not_found"
    };
  }

  heading.scrollIntoView({
    behavior: "instant",
    block: "start"
  });

  await sleep(1200);

  let pagesChecked = 0;
  let stopReason = "max_pages_reached";
  let consecutiveNoNew = 0;

  for (
    let page = 1;
    page <= MAX_PAGES;
    page++
  ) {
    const result = collectCurrentPage(page);

    pagesChecked++;

    if (reviews.length >= TARGET_REVIEWS) {
      stopReason = "target_reached";
      break;
    }

    if (result.cardsFound === 0) {
      stopReason = "no_review_cards";
      break;
    }

    if (result.added === 0) {
      consecutiveNoNew++;
    } else {
      consecutiveNoNew = 0;
    }

    // Dừng sớm nếu không lấy được bình luận,
    // tránh chạy hết 65 trang vô ích.
    if (consecutiveNoNew >= 2) {
      stopReason = "two_pages_without_new_reviews";
      break;
    }

    if (page >= MAX_PAGES) {
      stopReason = "max_pages_reached";
      break;
    }

    const nextButton = findNextButton();

    if (!nextButton) {
      stopReason = "next_button_not_found";
      break;
    }

    const previous = pageSignature();

    nextButton.click();

    const changed = await waitForPageChange(
      previous
    );

    if (!changed) {
      stopReason = "page_change_not_confirmed";
      break;
    }
  }

  // =====================================================
  // 11. FINAL RESULT
  // =====================================================

  const starDistribution = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    unknown: 0
  };

  for (const item of reviews) {
    const rating = item.rating;

    if (
      Number.isInteger(rating) &&
      rating >= 1 &&
      rating <= 5
    ) {
      starDistribution[rating]++;
    } else {
      starDistribution.unknown++;
    }
  }

  return {
    ok: true,
    platform: "shopee",

    product_id: productId,
    url: `${url.origin}${url.pathname}`,

    reviews,

    stats: {
      target: TARGET_REVIEWS,
      found: reviews.length,
      returned: reviews.length,
      pages_checked: pagesChecked,
      max_pages: MAX_PAGES,
      collection_mode: "all_filter_dom_order",
      star_distribution: starDistribution,
      stop_reason: stopReason
    },

    diagnostics,
    collected_at: new Date().toISOString()
  };
})()
