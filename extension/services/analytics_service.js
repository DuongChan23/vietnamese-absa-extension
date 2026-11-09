
"use strict";

// ============================================================
// 1. CONSTANTS AND HELPERS
// ============================================================

const SENTIMENTS = [
  "positive",
  "neutral",
  "negative",
];

// Keep this mapping consistent with
// backend/category_normalizer.py.
//
// Only labels verified as equivalent are merged.
// Do not automatically merge SER&ACC and Service.
const CATEGORY_ALIASES = {
  GENERAL: "General",
  General: "General",

  DESIGN: "Design",
  Design: "Design",

  PRICE: "Price",
  Price: "Price",
};

function normalizeCategory(value) {
  const category = String(
    value ?? "UNKNOWN"
  ).trim();

  return CATEGORY_ALIASES[category] || category || "UNKNOWN";
}

function emptyCounts() {
  return {
    positive: 0,
    neutral: 0,
    negative: 0,
  };
}

function percent(value, total) {
  return total > 0
    ? Math.round((value / total) * 1000) / 10
    : 0;
}

// ============================================================
// 2. SELECT ASPECT PREDICTIONS
// ============================================================

/**
 * Prefer Backend-normalized ABSA predictions.
 *
 * The original aspects field remains unchanged
 * in the API response for reproducibility.
 *
 * If the Backend has not been upgraded yet,
 * fall back to raw aspects for compatibility.
 */
function selectAspects(prediction) {
  if (Array.isArray(prediction?.aspects_merged)) {
    return prediction.aspects_merged;
  }

  if (Array.isArray(prediction?.aspects)) {
    return prediction.aspects;
  }

  return [];
}

// ============================================================
// 3. BUILD ANALYTICS
// ============================================================

/**
 * Statistics are computed from aspect-level sentiment,
 * not from review-level overall sentiment.
 *
 * Uses aspects_merged from the Backend whenever available.
 *
 * Category labels are normalized for display.
 * When falling back to raw aspects, label normalization
 * alone does not guarantee duplicate predictions are
 * removed; deduplication belongs to the Backend.
 */
export function buildAnalytics(
  batchResult,
  collectedReviews,
  shopeeRatings = null
) {
  const predictions = Array.isArray(batchResult?.results)
    ? batchResult.results
    : [];

  const collected = Array.isArray(collectedReviews)
    ? collectedReviews
    : [];

  const sentiments = emptyCounts();
  const categories = new Map();

  let reviewsWithAspects = 0;
  let validPredictions = 0;

  let usingMerged = 0;
  let usingRaw = 0;

  for (const prediction of predictions) {
    if (prediction?.status !== "ok") {
      continue;
    }

    validPredictions++;

    const aspects = selectAspects(prediction);

    if (Array.isArray(prediction.aspects_merged)) {
      usingMerged++;
    } else {
      usingRaw++;
    }

    let hasValidAspect = false;

    for (const aspect of aspects) {
      if (!aspect || typeof aspect !== "object") {
        continue;
      }

      const sentiment = String(
        aspect.sentiment ?? ""
      ).trim().toLowerCase();

      if (!SENTIMENTS.includes(sentiment)) {
        continue;
      }

      const category = normalizeCategory(
        aspect.category
      );

      hasValidAspect = true;

      sentiments[sentiment]++;

      if (!categories.has(category)) {
        categories.set(category, {
          name: category,
          ...emptyCounts(),
        });
      }

      categories.get(category)[sentiment]++;
    }

    if (hasValidAspect) {
      reviewsWithAspects++;
    }
  }

  // ==========================================================
  // 4. SENTIMENT TOTALS
  // ==========================================================

  const totalAspects = SENTIMENTS.reduce(
    (sum, key) => sum + sentiments[key],
    0
  );

  const sentimentPercentages =
    Object.fromEntries(
      SENTIMENTS.map((key) => [
        key,
        percent(
          sentiments[key],
          totalAspects
        ),
      ])
    );

  // ==========================================================
  // 5. CATEGORY STATISTICS
  // ==========================================================

  const categoryStats = [
    ...categories.values()
  ]
    .map((item) => {
      const total = SENTIMENTS.reduce(
        (sum, key) => sum + item[key],
        0
      );

      return {
        ...item,
        total,

        positivePct: percent(
          item.positive,
          total
        ),

        neutralPct: percent(
          item.neutral,
          total
        ),

        negativePct: percent(
          item.negative,
          total
        ),
      };
    })
    .sort((a, b) => {
      if (b.total !== a.total) {
        return b.total - a.total;
      }

      return a.name.localeCompare(b.name);
    });

  // ==========================================================
  // 6. RATING STATISTICS
  // ==========================================================

  // Native Shopee totals include ratings without written comments. Never
  // derive them from the selected comment sample or invent missing buckets.
  const nonNegativeInteger = value => value !== null && value !== undefined && value !== '' &&
    Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const ratingCounts = Object.fromEntries([1, 2, 3, 4, 5].map(star =>
    [star, nonNegativeInteger(shopeeRatings?.counts?.[star])]
  ));
  const distributionAvailable = Object.values(ratingCounts).every(value => value !== null);
  const nativeTotal = nonNegativeInteger(shopeeRatings?.total);
  const totalRated = nativeTotal ?? (distributionAvailable
    ? Object.values(ratingCounts).reduce((sum, count) => sum + count, 0) : null);
  const rawAverage = shopeeRatings?.average;
  const averageRating = rawAverage !== null && rawAverage !== undefined && rawAverage !== '' &&
    Number.isFinite(Number(rawAverage)) && Number(rawAverage) >= 0 && Number(rawAverage) <= 5
    ? Number(rawAverage) : null;

  // ==========================================================
  // 7. RETURN ANALYTICS
  // ==========================================================

  return {
    requested:
      batchResult?.requested ??
      collected.length,

    submitted:
      batchResult?.submitted ?? 0,

    analyzed: validPredictions,
    collected: collected.length,

    reviewsWithAspects,
    totalAspects,

    sentiments,
    sentimentPercentages,

    categories: categoryStats,

    ratings: {
      counts: ratingCounts,
      known: totalRated,
      total: totalRated,
      source: 'shopee',
      distributionAvailable,
      approximate: Boolean(shopeeRatings?.approximate),
      totalApproximate: Boolean(shopeeRatings?.total_approximate),
      average: averageRating,
    },

    // Additional metadata; does not replace
    // any previous analytics fields.
    categoryNormalization: {
      policy:
        batchResult?.category_merge_policy ??
        "frontend_alias_fallback",

      usingMerged,
      usingRaw,

      fullyMerged:
        validPredictions > 0 &&
        usingMerged === validPredictions,
    },
  };
}

// ============================================================
// 8. CSV ESCAPING
// ============================================================

function csvEscape(value) {
  const text = String(value ?? "");

  // Protect spreadsheet applications
  // against formula injection.
  const safe = /^[\s]*[=+\-@\t\r]/.test(text)
    ? "'" + text
    : text;

  return `"${safe.replace(/"/g, '""')}"`;
}

// ============================================================
// 9. EXPORT REVIEWS CSV
// ============================================================

export function buildReviewsCSV(reviews) {
  const rows = [
    [
      "product_id",
      "review_id",
      "rating",
      "created_at",
      "text",
    ],
  ];

  const items = Array.isArray(reviews)
    ? reviews
    : [];

  for (const review of items) {
    rows.push([
      review?.product_id ?? "",
      review?.review_id ?? "",
      review?.rating ?? "",
      review?.created_at ?? "",
      review?.text ?? "",
    ]);
  }

  return "\uFEFF" +
    rows
      .map((row) =>
        row.map(csvEscape).join(",")
      )
      .join("\r\n");
}

// ============================================================
// 10. EXPORT CATEGORY CSV
// ============================================================

export function buildCategoryCSV(analytics) {
  const rows = [
    [
      "category",
      "total",
      "positive",
      "neutral",
      "negative",
      "positive_pct",
      "neutral_pct",
      "negative_pct",
    ],
  ];

  const categories = Array.isArray(
    analytics?.categories
  )
    ? analytics.categories
    : [];

  for (const category of categories) {
    rows.push([
      category.name,
      category.total,
      category.positive,
      category.neutral,
      category.negative,
      category.positivePct,
      category.neutralPct,
      category.negativePct,
    ]);
  }

  return "\uFEFF" +
    rows
      .map((row) =>
        row.map(csvEscape).join(",")
      )
      .join("\r\n");
}
