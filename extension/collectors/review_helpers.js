(() => {
  "use strict";

  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const contentSelectors = [
    '.shopee-product-rating__content--original', '.shopee-product-rating__content',
    '[data-testid="review-content"]', '[data-testid="rating-content"]'
  ];
  const datePattern = /20\d{2}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}/;
  const visible = element => Boolean(element?.isConnected && element.getClientRects().length &&
    getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
  const text = element => String(element?.innerText ?? element?.textContent ?? '');

  function buyerText(value) {
    const lines = String(value ?? '').split(
      /(?:^|\n)\s*(?:Phản Hồi Của Người Bán|Phản Hồi Từ Người Bán|Seller(?:'s)? Response)(?:\s*[:：]|\s*(?:\n|$))/i
    )[0].split(/\n+/).map(clean).filter(Boolean);
    const kept = [];
    for (const line of lines) {
      if (/^[|\-]?\s*phân loại(?: hàng| sản phẩm)?\s*:/i.test(line)) continue;
      if (/^(màu sắc|kích cỡ|size)\s*:/i.test(line)) continue;
      if (/^(?:chất liệu|chất lượng sản phẩm|đúng với mô tả|thiết kế|nội dung đánh giá)\s*:\s*[-–—]*$/i.test(line)) continue;
      if (/^(?:người dùng|khách hàng)(?: này)?\s+(?:đã\s+)?(?:không|chưa)\s+(?:để lại|viết)\s+(?:bình luận|nhận xét|đánh giá)(?:[.!\s]|$)/i.test(line) ||
          /^(?:không có|chưa có)\s+(?:bình luận|nhận xét)[.!\s]*$/i.test(line) ||
          /^no (?:comment|review)(?: provided)?[.!\s]*$/i.test(line)) continue;
      if (/^(?:[1-5]\s*(?:sao|stars?)|hữu ích\??(?:\s*\(?\d+\)?)?|thích(?:\s*\(?\d+\)?)?|báo cáo|trả lời|xem thêm|đã mua hàng|(?:ảnh|video)(?:\s*\(\d+\))?|\d+\s*(?:thích|hữu ích|lượt thích)|\d+:\d{2}|\d+|[★☆⭐🌟\s]+)$/i.test(line)) continue;
      kept.push(line);
    }
    const result = clean(kept.join(' '));
    // Stars, counters, toolbar punctuation and empty placeholders are not a
    // buyer comment. Short written comments and emoji such as "ok"/"👍" count.
    const meaningful = result.replace(/[★☆⭐🌟✩✭✮✯✰]/gu, '');
    return result.length <= 3000 && /[\p{L}\p{Extended_Pictographic}]/u.test(meaningful)
      ? result : null;
  }

  function extractBuyerComment(card) {
    let hasContent = false;
    for (const selector of contentSelectors) {
      const element = card.querySelector(selector);
      if (!element || !visible(element)) continue;
      hasContent = true;
      const result = buyerText(text(element));
      if (result) return result;
    }
    // An explicitly empty content node must not turn surrounding star/like
    // metadata into a comment through the fallback.
    if (hasContent) return null;
    const fullText = text(card);
    const date = datePattern.exec(fullText);
    return date ? buyerText(fullText.slice(date.index + date[0].length)) : null;
  }

  function parseCount(value) {
    const normalized = clean(value).replace(/\s/g, '').toLowerCase();
    if (/^\d+$/.test(normalized)) return { value: Number(normalized), approximate: false };
    if (/^\d{1,3}(?:[.,]\d{3})+$/.test(normalized)) {
      return { value: Number(normalized.replace(/[.,]/g, '')), approximate: false };
    }
    const compact = normalized.match(/^(\d+(?:[.,]\d+)?)([km])$/);
    return compact ? {
      value: Math.round(Number(compact[1].replace(',', '.')) * (compact[2] === 'k' ? 1000 : 1000000)),
      approximate: true
    } : null;
  }

  function readShopeeRatingSummary(root, { average = null, total = null } = {}) {
    const counts = { 1: null, 2: null, 3: null, 4: null, 5: null };
    let approximate = false;
    let allCount = null;
    const filters = root.querySelectorAll('.product-rating-overview__filter, [data-testid="rating-filter"]');
    for (const filter of filters) {
      if (!visible(filter)) continue;
      const label = clean(text(filter));
      const match = label.match(/^([1-5])\s*(?:sao|stars?)\s*\(([^)]+)\)$/i);
      const all = label.match(/^tất cả\s*\(([^)]+)\)$/i);
      const count = parseCount(filter.getAttribute('data-count') ?? match?.[2] ?? all?.[1]);
      if (!count) continue;
      if (match) counts[match[1]] = count.value;
      if (all) allCount = count;
      approximate ||= count.approximate;
    }
    const validNumber = value => value !== null && value !== undefined && value !== '' &&
      Number.isFinite(Number(value));
    const numericAverage = validNumber(average) ? Number(average) : null;
    if (numericAverage === null) {
      const score = root.querySelector('.product-rating-overview__rating-score');
      const raw = clean(text(score)).replace(',', '.');
      if (/^[0-5](?:\.\d+)?$/.test(raw)) average = Number(raw);
    }
    const distributionAvailable = Object.values(counts).every(Number.isInteger);
    const suppliedTotal = validNumber(total) && Number.isInteger(Number(total)) && Number(total) >= 0
      ? Number(total) : null;
    const reportedTotal = allCount && (!allCount.approximate || suppliedTotal === null)
      ? allCount.value : suppliedTotal;
    return {
      source: 'shopee', counts, distribution_available: distributionAvailable,
      approximate,
      total_approximate: reportedTotal !== null ? Boolean(allCount?.approximate && suppliedTotal === null)
        : distributionAvailable && approximate,
      average: validNumber(average) && Number(average) >= 0 && Number(average) <= 5 ? Number(average) : null,
      total: reportedTotal ?? (distributionAvailable ? Object.values(counts).reduce((sum, n) => sum + n, 0) : null)
    };
  }

  globalThis.__absaReviewHelpers = { extractBuyerComment, buyerText, parseCount, readShopeeRatingSummary };
})();
