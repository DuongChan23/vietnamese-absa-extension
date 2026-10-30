
(() => {
  "use strict";

  // =====================================================
  // 1. HELPERS
  // =====================================================

  const clean = (value) =>
    String(value ?? "").replace(/\s+/g, " ").trim();

  const meta = (keys) => {
    for (const key of keys) {
      const element = [...document.querySelectorAll("meta")].find(
        (el) =>
          el.getAttribute("property") === key ||
          el.getAttribute("name") === key
      );
      if (element?.content) return clean(element.content);
    }
    return null;
  };

  const visible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };

  const firstText = (selectors) => {
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const value = clean(el.textContent);
        if (value) return value;
      }
    }
    return null;
  };

  // =====================================================
  // 2. READ STRUCTURED PRODUCT DATA
  // =====================================================

  function getProductSchema() {
    const queue = [];

    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        queue.push(JSON.parse(script.textContent));
      } catch {
        // Invalid JSON-LD should not stop extraction.
      }
    }

    while (queue.length) {
      const node = queue.shift();

      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }

      if (!node || typeof node !== "object") continue;

      const types = Array.isArray(node["@type"])
        ? node["@type"]
        : [node["@type"]];

      if (
        types.some(
          (type) => String(type).toLowerCase() === "product"
        )
      ) {
        return node;
      }

      if (node["@graph"]) queue.push(node["@graph"]);
      if (node.mainEntity) queue.push(node.mainEntity);
    }

    return {};
  }

  // =====================================================
  // 3. PRODUCT ID FROM URL
  // =====================================================

  const url = new URL(window.location.href);

  if (
    url.protocol !== "https:" ||
    !(
      url.hostname === "shopee.vn" ||
      url.hostname.endsWith(".shopee.vn")
    )
  ) {
    return {
      ok: false,
      error: "not_shopee_vietnam",
    };
  }

  const match = url.pathname.match(
    /-i\.(\d+)\.(\d+)(?:\/|$)/
  );

  const shopId =
    match?.[1] ||
    url.searchParams.get("shopid") ||
    null;

  const itemId =
    match?.[2] ||
    url.searchParams.get("itemid") ||
    null;

  if (!shopId || !itemId) {
    return {
      ok: false,
      error: "not_recognized_product_page",
    };
  }

  const schema = getProductSchema();

  // =====================================================
  // 4. PRODUCT NAME
  // =====================================================

  const name =
    clean(schema.name) ||
    firstText([
      '[data-testid="pdp-product-name"]',
      "h1",
    ]) ||
    meta(["og:title", "twitter:title"]) ||
    clean(document.title) ||
    null;

  // =====================================================
  // 5. PRODUCT PRICE
  // =====================================================

  const priceRegex = /(?:₫|đ)\s*[\d.,]+|[\d][\d.,]*\s*(?:₫|đ)/i;

  const excludedPriceWords =
    /voucher|mã giảm|giảm giá|giảm\s*\d|hoàn xu|phí ship|phí vận chuyển|tiết kiệm/i;

  function validPriceText(value) {
    const content = clean(value);

    if (!content || content.length > 85) return null;
    if (excludedPriceWords.test(content)) return null;

    const match = content.match(priceRegex);
    return match ? clean(match[0]) : null;
  }

  function getPrice() {
    // Priority 1: structured product offer.
    const offers = Array.isArray(schema.offers)
      ? schema.offers[0]
      : schema.offers;

    if (offers?.price !== undefined && offers.price !== null) {
      const number = Number(offers.price);

      if (Number.isFinite(number) && number > 0) {
        return {
          value: `${number.toLocaleString("vi-VN")}đ`,
          source: "jsonld_offer",
        };
      }
    }

    // Priority 2: product price metadata.
    const metaPrice = meta([
      "product:price:amount",
      "og:price:amount",
    ]);

    if (metaPrice) {
      const number = Number(metaPrice);

      if (Number.isFinite(number) && number > 0) {
        return {
          value: `${number.toLocaleString("vi-VN")}đ`,
          source: "price_metadata",
        };
      }
    }

    // Priority 3: Shopee price selectors.
    const selectors = [
      '[data-testid="pdp-product-price"]',
      '[class*="product-price"]',
      '[class*="productPrice"]',
      '[class*="price-current"]',
      '[class*="priceCurrent"]',
    ];

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;

        const price = validPriceText(el.textContent);

        if (price) {
          return {
            value: price,
            source: "price_selector",
          };
        }
      }
    }

    // Priority 4: visible price candidates close to
    // the main product title, avoiding vouchers.
    const titleEl =
      document.querySelector(
        '[data-testid="pdp-product-name"]'
      ) ||
      document.querySelector("h1");

    const titleRect = titleEl?.getBoundingClientRect();

    if (!titleRect) return null;

    const candidates = [];

    for (const el of document.querySelectorAll(
      "main span, main div, span, div"
    )) {
      if (!visible(el)) continue;

      // Leaf-like elements reduce duplicated parent text.
      if (
        [...el.children].some(
          (child) => clean(child.textContent).length > 0
        )
      ) {
        continue;
      }

      const content = clean(el.textContent);
      const price = validPriceText(content);

      if (!price) continue;

      const rect = el.getBoundingClientRect();

      // Product price normally appears shortly below
      // the product title, not in voucher sections.
      const distanceY = rect.top - titleRect.bottom;
      const distanceX = Math.abs(
        rect.left - titleRect.left
      );

      if (distanceY < -30 || distanceY > 350) continue;
      if (distanceX > 700) continue;

      const style = getComputedStyle(el);

      const fontSize = parseFloat(style.fontSize) || 0;

      candidates.push({
        price,
        score:
          Math.abs(distanceY) +
          distanceX * 0.15 -
          fontSize * 2,
      });
    }

    candidates.sort((a, b) => a.score - b.score);

    if (candidates.length) {
      return {
        value: candidates[0].price,
        source: "visible_price_near_title",
      };
    }

    return null;
  }

  const priceResult = getPrice();

  // =====================================================
  // 6. PRODUCT RATING
  // =====================================================

  function getRating() {
    const raw = schema.aggregateRating?.ratingValue;

    if (raw !== undefined && raw !== null) {
      const value = Number(raw);

      if (value >= 0 && value <= 5) return value;
    }

    const ratingText = firstText([
      '[data-testid="pdp-product-rating"]',
      '[class*="product-rating"]',
      '[class*="rating-score"]',
    ]);

    if (ratingText) {
      const match = ratingText.match(/\b[0-5](?:[.,]\d{1,2})?\b/);

      if (match) {
        const value = Number(match[0].replace(",", "."));
        if (value >= 0 && value <= 5) return value;
      }
    }

    return null;
  }

  // =====================================================
  // 7. REVIEW COUNT (2,6k -> 2600)
  // =====================================================

  function parseCompactNumber(raw) {
    const value = clean(raw)
      .toLowerCase()
      .replace(/\s/g, "");

    if (!value) return null;

    if (/[km]$/.test(value)) {
      const unit = value.slice(-1);
      const base = Number(
        value.slice(0, -1).replace(",", ".")
      );

      if (!Number.isFinite(base)) return null;

      return Math.round(
        base * (unit === "k" ? 1000 : 1000000)
      );
    }

    // Examples: 2.634 -> 2634, 2634 -> 2634
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(value)) {
      return Number(value.replace(/[.,]/g, ""));
    }

    if (/^\d+$/.test(value)) return Number(value);

    return null;
  }

  function getReviewCount() {
    const structured =
      schema.aggregateRating?.reviewCount ??
      schema.aggregateRating?.ratingCount;

    if (structured !== undefined && structured !== null) {
      const number = Number(structured);

      if (Number.isFinite(number) && number >= 0) {
        return {
          value: number,
          source: "jsonld_aggregate_rating",
        };
      }
    }

    // Match: "2,6k Đánh Giá" or "Đánh Giá 2,6k"
    const countPattern =
      /([\d.,]+\s*[kKmM]?)\s*(?:đánh giá|nhận xét|reviews?)|(?:đánh giá|nhận xét|reviews?)\s*([\d.,]+\s*[kKmM]?)/i;

    const candidates = [];

    for (const el of document.querySelectorAll(
      "a, span, div"
    )) {
      if (!visible(el)) continue;

      const value = clean(el.textContent);

      if (!value || value.length > 85) continue;

      const match = value.match(countPattern);

      if (!match) continue;

      const count = parseCompactNumber(
        match[1] || match[2]
      );

      if (count === null) continue;

      // Prefer the smallest matching element rather
      // than a parent containing the whole page.
      candidates.push({
        count,
        length: value.length,
      });
    }

    candidates.sort((a, b) => a.length - b.length);

    if (candidates.length) {
      return {
        value: candidates[0].count,
        source: "visible_review_label",
      };
    }

    return null;
  }

  const reviewCountResult = getReviewCount();

  // =====================================================
  // 8. PRODUCT DESCRIPTION
  // =====================================================

  const description =
    clean(schema.description) ||
    firstText([
      '[data-testid="pdp-product-description"]',
      '[class*="product-description"]',
    ]) ||
    meta(["og:description"]) ||
    null;

  // =====================================================
  // 9. FINAL PRODUCT JSON
  // =====================================================

  return {
    ok: true,
    platform: "shopee",

    shop_id: shopId,
    item_id: itemId,
    product_id: `${shopId}.${itemId}`,

    url: `${url.origin}${url.pathname}`,
    name,

    price_text: priceResult?.value ?? null,
    price_source: priceResult?.source ?? null,

    rating: getRating(),

    review_count: reviewCountResult?.value ?? null,
    review_count_source:
      reviewCountResult?.source ?? null,

    description,

    collected_at: new Date().toISOString(),

    availability: {
      name: Boolean(name),
      price: Boolean(priceResult),
      description: Boolean(description),
      rating: getRating() !== null,
      review_count: Boolean(reviewCountResult),
    },
  };
})()
