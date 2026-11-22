"use strict";

const SENTIMENTS = ["positive", "neutral", "negative"];
const CATEGORY_ALIASES = {
  GENERAL: "General", DESIGN: "Design", PRICE: "Price", "SER&ACC": "Service"
};
const emptyCounts = () => ({ positive: 0, neutral: 0, negative: 0 });
const percent = (value, total) => total > 0 ? Math.round(value / total * 1000) / 10 : 0;
const nonNegativeInteger = value => value !== null && value !== undefined && value !== "" &&
  Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

// An explicitly empty merged list is valid and must not fall back to raw aspects.
function selectAspects(prediction) {
  if (Array.isArray(prediction?.aspects_merged)) return prediction.aspects_merged;
  return Array.isArray(prediction?.aspects) ? prediction.aspects : [];
}

export function buildAnalytics(batchResult, collectedReviews, shopeeRatings = null) {
  const predictions = Array.isArray(batchResult?.results) ? batchResult.results : [];
  const collected = Array.isArray(collectedReviews) ? collectedReviews : [];
  const sentiments = emptyCounts();
  const categories = new Map();
  let reviewsWithAspects = 0;
  let validPredictions = 0;
  let usingMerged = 0;

  for (const prediction of predictions) {
    if (prediction?.status !== "ok") continue;
    validPredictions++;
    if (Array.isArray(prediction.aspects_merged)) usingMerged++;
    let hasValidAspect = false;
    for (const aspect of selectAspects(prediction)) {
      if (!aspect || typeof aspect !== "object") continue;
      const sentiment = String(aspect.sentiment ?? "").trim().toLowerCase();
      if (!SENTIMENTS.includes(sentiment)) continue;
      const label = String(aspect.category ?? "UNKNOWN").trim();
      const category = Object.hasOwn(CATEGORY_ALIASES, label) ? CATEGORY_ALIASES[label] : label || "UNKNOWN";
      hasValidAspect = true;
      sentiments[sentiment]++;
      if (!categories.has(category)) categories.set(category, { name: category, ...emptyCounts() });
      categories.get(category)[sentiment]++;
    }
    if (hasValidAspect) reviewsWithAspects++;
  }

  const totalAspects = SENTIMENTS.reduce((sum, key) => sum + sentiments[key], 0);
  const categoryStats = [...categories.values()].map(item => {
    const total = SENTIMENTS.reduce((sum, key) => sum + item[key], 0);
    return {
      ...item, total,
      positivePct: percent(item.positive, total),
      neutralPct: percent(item.neutral, total),
      negativePct: percent(item.negative, total)
    };
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // Native Shopee totals include star-only ratings; never derive them from comments.
  const counts = Object.fromEntries([1, 2, 3, 4, 5].map(star =>
    [star, nonNegativeInteger(shopeeRatings?.counts?.[star])]
  ));
  const distributionAvailable = Object.values(counts).every(value => value !== null);
  const total = nonNegativeInteger(shopeeRatings?.total) ?? (distributionAvailable
    ? Object.values(counts).reduce((sum, count) => sum + count, 0) : null);
  const rawAverage = shopeeRatings?.average;
  const average = rawAverage !== null && rawAverage !== undefined && rawAverage !== "" &&
    Number.isFinite(Number(rawAverage)) && Number(rawAverage) >= 0 && Number(rawAverage) <= 5
    ? Number(rawAverage) : null;

  return {
    requested: batchResult?.requested ?? collected.length,
    submitted: batchResult?.submitted ?? 0,
    analyzed: validPredictions,
    collected: collected.length,
    reviewsWithAspects, totalAspects, sentiments,
    sentimentPercentages: Object.fromEntries(SENTIMENTS.map(key => [key, percent(sentiments[key], totalAspects)])),
    categories: categoryStats,
    ratings: {
      counts, known: total, total, source: "shopee", distributionAvailable, average,
      approximate: Boolean(shopeeRatings?.approximate),
      totalApproximate: Boolean(shopeeRatings?.total_approximate)
    },
    categoryNormalization: {
      policy: batchResult?.category_merge_policy ?? "frontend_alias_fallback",
      usingMerged, usingRaw: validPredictions - usingMerged,
      fullyMerged: validPredictions > 0 && usingMerged === validPredictions
    }
  };
}
