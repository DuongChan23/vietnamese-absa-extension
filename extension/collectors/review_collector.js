
(() => {
  // The collector runs in the page. Return an acknowledgement immediately so
  // collecting many pages does not depend on one long-lived worker message.
  const completionRunId = document.documentElement.dataset.absaCollectionRun;
  const completionProductId = document.documentElement.dataset.absaExpectedProduct;
  const completionStarted = performance.now();
  const task = (async () => {
  "use strict";

  // =====================================================
  // 1. CONFIGURATION
  // =====================================================

  const rawLimit = document.documentElement.dataset.absaReviewLimit;
  const requested = Number(rawLimit);
  const COLLECT_ALL = rawLimit === "all";
  const runId = document.documentElement.dataset.absaCollectionRun;
  const collectionStarted = performance.now();

  delete document.documentElement.dataset.absaReviewLimit;

  const TARGET_REVIEWS = COLLECT_ALL ? Infinity : [50, 100, 200].includes(requested)
    ? requested
    : 50;

  const MAX_PAGES = COLLECT_ALL ? Infinity : 65;
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
  ) || url.pathname.match(/^\/product\/(\d+)\/(\d+)(?:\/|$)/) ||
    (/^\d+$/.test(url.searchParams.get("shopid") || "") &&
     /^\d+$/.test(url.searchParams.get("itemid") || "")
      ? ["", url.searchParams.get("shopid"), url.searchParams.get("itemid")] : null);

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

  function assertCurrentCollection() {
    const current = new URL(location.href);
    const match = current.pathname.match(/-i\.(\d+)\.(\d+)(?:\/|$)/) ||
      current.pathname.match(/^\/product\/(\d+)\/(\d+)(?:\/|$)/);
    const id = match ? `${match[1]}.${match[2]}` :
      `${current.searchParams.get("shopid")}.${current.searchParams.get("itemid")}`;
    if (id !== productId || (runId &&
        document.documentElement.dataset.absaCollectionRun !== runId) ||
        (document.documentElement.dataset.absaExpectedProduct &&
         document.documentElement.dataset.absaExpectedProduct !== productId)) {
      throw new Error("collection_cancelled_or_product_changed");
    }
  }
  assertCurrentCollection();

  const reviews = [];
  const seenKeys = new Set();
  const diagnostics = [];
  let reviewRoot = document;

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

  function extractText(card) {
    return globalThis.__absaReviewHelpers.extractBuyerComment(card);
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
      ...reviewRoot.querySelectorAll(".d72He7")
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
            extracted.length > 0
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
        ...reviewRoot.querySelectorAll(
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

    // Shopee review DOM (verified 2026-10-28):
    // .BnXxkm > .rGdC5O contains exactly five SVG stars.
    // icon-rating-solid = filled; icon-rating = outlined.
    // Prefer this explicit distinction over SVG geometry: both
    // variants share the same polygon points.
    const starRows = card.querySelectorAll(
      ".BnXxkm .rGdC5O, .d72He7 .rGdC5O"
    );
    for (const row of starRows) {
      const stars = [...row.querySelectorAll("svg.shopee-svg-icon")];
      if (stars.length !== 5) continue;

      const kinds = stars.map((star) => {
        if (star.classList.contains("icon-rating-solid")) return "filled";
        if (star.classList.contains("icon-rating")) return "outline";
        return "unknown";
      });
      if (kinds.includes("unknown")) continue;

      const filledCount = kinds.filter((kind) => kind === "filled").length;
      // Accept only a normal left-to-right sequence of filled then
      // outline stars. This also correctly handles all five filled.
      if (
        filledCount >= 1 &&
        kinds.every((kind, index) =>
          index < filledCount ? kind === "filled" : kind === "outline"
        )
      ) {
        return filledCount;
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

    const pageStats = {
      page,
      cards_found: cards.length,
      added,
      skipped_empty: skippedEmpty,
      skipped_duplicate: skippedDuplicate,
      rating_unknown: unknownRatings,
      total_collected: reviews.length
    };
    diagnostics.push(pageStats);
    if (runId) {
      void chrome.runtime.sendMessage({
        type: "ABSA_COLLECTION_PROGRESS", run_id: runId, product_id: productId,
        duration_ms: performance.now() - collectionStarted,
        stats: { page, collected: reviews.length, added, skipped_empty: skippedEmpty,
          skipped_duplicate: skippedDuplicate, cards_found: cards.length }
      }).catch(() => {});
    }

    return {
      cardsFound: cards.length,
      added
    };
  }

  // =====================================================
  // 9. PAGINATION
  // =====================================================

  function isDisabled(button) {
    return button.disabled || button.getAttribute('disabled') !== null ||
      button.getAttribute("aria-disabled") === "true" ||
      button.classList.contains("shopee-icon-button--disabled") ||
      button.classList.contains('disabled') ||
      getComputedStyle(button).pointerEvents === 'none';
  }

  function paginationState() {
    const buttons = [...reviewRoot.querySelectorAll('.shopee-page-controller button')]
      .filter(button => visible(button) && /^\d+$/.test(clean(button.textContent)));
    const active = buttons.find(button =>
      ['page', 'true'].includes(button.getAttribute('aria-current')) ||
      button.getAttribute('aria-selected') === 'true' ||
      button.classList.contains('shopee-button-solid--primary') ||
      button.classList.contains('shopee-button-no-outline--primary'));
    return {
      page: active ? Number(clean(active.textContent)) : null,
      firstButton: buttons.find(button => clean(button.textContent) === '1')
    };
  }

  function findNavigationButton(direction) {
    const selectors = direction === "next" ? [
      ".shopee-page-controller .shopee-icon-button--right",
      '[aria-label="Next"]', '[aria-label="Trang sau"]',
      'button[aria-label*="next" i]'
    ] : [
      ".shopee-page-controller .shopee-icon-button--left",
      '[aria-label="Previous"]', '[aria-label="Trang trước"]',
      'button[aria-label*="previous" i]'
    ];

    for (const selector of selectors) {
      const button = [
        ...reviewRoot.querySelectorAll(selector)
      ].find(element =>
        visible(element)
      );

      if (button) return button;
    }

    return null;
  }

  async function waitForPageChange(previous, { fromPage = null, expectedPage = null, filterSelected = null } = {}) {
    const deadline = Date.now() + PAGE_WAIT_MS;
    let stableSignature = null;
    let stableSince = 0;

    while (Date.now() < deadline) {
      await sleep(350);
      assertCurrentCollection();

      const current = pageSignature();
      const page = paginationState().page;
      const reachedPage = expectedPage !== null && page === expectedPage;

      // A click on page 1 while already there legitimately leaves content
      // unchanged. Page markers also disambiguate pages with identical text.
      if (reachedPage && fromPage === expectedPage) return true;
      if (current !== stableSignature) {
        stableSignature = current;
        stableSince = Date.now();
      }

      if (
        ((current && current !== previous) || reachedPage || filterSelected?.()) &&
        Date.now() - stableSince >= 700
      ) {
        await sleep(500);
        assertCurrentCollection();
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

  reviewRoot = heading.closest(
    '.product-ratings, .shopee-product-ratings, [data-testid="product-ratings"]'
  );
  if (!reviewRoot) {
    let ancestor = heading.parentElement;
    while (ancestor && ancestor !== document.body) {
      if (ancestor.querySelector('.shopee-page-controller')) {
        reviewRoot = ancestor;
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  reviewRoot ||= heading.closest("section") || heading.parentElement;

  heading.scrollIntoView({
    behavior: "instant",
    block: "start"
  });

  await sleep(1200);
  assertCurrentCollection();

  // Prefer Shopee's written-comment filter to avoid paging through ratings
  // without text. If absent, scan all ratings and reject empty cards locally.
  const filters = [...reviewRoot.querySelectorAll(
    '.product-rating-overview__filter, [data-testid="rating-filter"], button'
  )];
  const allFilter = filters.find(button => visible(button) &&
    /^tất cả(?:\s*\(|$)/i.test(clean(button.textContent)));
  const commentFilter = filters.find(button => visible(button) &&
    /^có\s+(?:bình luận|nội dung)(?:\s*\(|$)/i.test(clean(button.textContent)));
  const isFilterSelected = button => button.classList.contains('product-rating-overview__filter--active') ||
    button.getAttribute('aria-pressed') === 'true';

  // Restore the overall view before reading native totals, including when a
  // previous run left "Có bình luận" or a single-star filter selected.
  if (allFilter && !isFilterSelected(allFilter)) {
    const previous = pageSignature();
    allFilter.click();
    await waitForPageChange(previous, { filterSelected: () => isFilterSelected(allFilter) });
    assertCurrentCollection();
  }
  const ratingSummary = globalThis.__absaReviewHelpers.readShopeeRatingSummary(reviewRoot);
  const chosenFilter = commentFilter || allFilter;
  if (COLLECT_ALL && !chosenFilter) {
    return { ok: false, error: 'all_rating_filter_not_found' };
  }
  if (chosenFilter && !isFilterSelected(chosenFilter)) {
    const previous = pageSignature();
    chosenFilter.click();
    await waitForPageChange(previous, { filterSelected: () => isFilterSelected(chosenFilter) });
    assertCurrentCollection();
  }

  const resetSignatures = new Set();
  while (true) {
    assertCurrentCollection();
    const previousButton = findNavigationButton('previous');
    const state = paginationState();
    // The selected page is authoritative. Some Shopee arrow elements appear
    // enabled even on page 1, so their DOM property alone cannot drive reset.
    if (state.page === 1) break;
    const previousEnabled = previousButton && !isDisabled(previousButton);
    if (!previousEnabled && state.page === null) break;
    const signature = pageSignature();
    const resetKey = `${state.page ?? '?'}:${signature}`;
    if (resetSignatures.has(resetKey)) {
      return { ok: false, error: 'first_page_not_confirmed' };
    }
    resetSignatures.add(resetKey);
    const resetButton = state.firstButton || (previousEnabled ? previousButton : null);
    if (!resetButton) return { ok: false, error: 'first_page_not_confirmed' };
    resetButton.click();
    const expectedPage = state.firstButton ? 1 : state.page !== null ? state.page - 1 : null;
    if (!await waitForPageChange(signature, { fromPage: state.page, expectedPage })) {
      return { ok: false, error: 'first_page_not_confirmed' };
    }
  }

  let pagesChecked = 0;
  let stopReason = "max_pages_reached";
  const visitedPages = new Set();

  for (
    let page = 1;
    page <= MAX_PAGES;
    page++
  ) {
    assertCurrentCollection();
    const signature = pageSignature();
    const currentPage = paginationState().page;
    const pageKey = currentPage !== null ? `page:${currentPage}` : signature;
    if (pageKey && visitedPages.has(pageKey)) {
      stopReason = 'repeated_page';
      break;
    }
    if (pageKey) visitedPages.add(pageKey);
    collectCurrentPage(page);

    pagesChecked++;

    if (reviews.length >= TARGET_REVIEWS) {
      stopReason = "target_reached";
      break;
    }

    // Empty/star-only pages do not imply that later pages have no comments.

    if (page >= MAX_PAGES) {
      stopReason = "max_pages_reached";
      break;
    }

    const nextButton = findNavigationButton('next');

    if (!nextButton) {
      stopReason = "pagination_end_or_unavailable";
      break;
    }
    if (isDisabled(nextButton)) {
      stopReason = 'end_of_reviews';
      break;
    }

    const previous = pageSignature();

    assertCurrentCollection();
    nextButton.click();

    const changed = await waitForPageChange(
      previous,
      { fromPage: currentPage, expectedPage: currentPage !== null ? currentPage + 1 : null }
    );

    if (!changed) {
      stopReason = "page_change_not_confirmed";
      break;
    }
  }
  assertCurrentCollection();

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
    run_id: runId || null,
    url: `${url.origin}${url.pathname}`,

    reviews,
    rating_summary: ratingSummary,

    stats: {
      target: COLLECT_ALL ? null : TARGET_REVIEWS,
      found: reviews.length,
      returned: reviews.length,
      pages_checked: pagesChecked,
      max_pages: COLLECT_ALL ? null : MAX_PAGES,
      collection_mode: COLLECT_ALL ? "all_available_comment_pages" : "comment_pages_until_target",
      review_filter: commentFilter ? 'with_comments' : 'all',
      duration_ms: performance.now() - collectionStarted,
      comment_star_distribution: starDistribution,
      skipped_without_comment: diagnostics.reduce((sum, page) => sum + page.skipped_empty, 0),
      stop_reason: stopReason
    },

    diagnostics,
    collected_at: new Date().toISOString()
  };
  })();
  const sendResult = data => {
    void chrome.runtime.sendMessage({
      type: 'ABSA_COLLECTION_DONE', run_id: completionRunId,
      product_id: completionProductId, duration_ms: performance.now() - completionStarted, data
    }).catch(() => {});
  };
  void task.then(sendResult, error => sendResult({ ok: false, error: error.message }));
  return { ok: true, started: true, run_id: completionRunId };
})()
