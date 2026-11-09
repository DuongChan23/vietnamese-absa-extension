
"use strict";

import { logActivity } from "./activity_service.js";

const API_URL = "http://127.0.0.1:8000";
const BATCH_SIZE = 10;

/**
 * Phân tích danh sách bình luận bằng API ABSA hiện có.
 * Không tải lại mô hình và không thay đổi nội dung văn bản.
 */
export async function analyzeReviewBatch(
  reviews,
  productId,
  onProgress = () => {},
  { signal, runId } = {}
) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    throw new Error("Chưa có bình luận để phân tích.");
  }

  const results = [];
  const rejected = [];
  const total = reviews.length;
  let processed = 0;
  let batchError = null;
  const context = { runId, productId };

  for (let start = 0; start < total; start += BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = reviews.slice(start, start + BATCH_SIZE);
    const started = performance.now();
    const batchNumber = Math.floor(start / BATCH_SIZE) + 1;
    void logActivity("analysis_batch_started", context, {
      batch: batchNumber, reviews: batch.length
    });

    const payload = {
      source: "unified",
      run_id: runId || null,
      product_id: productId || null,
      reviews: batch.map((item) => ({
        review_id: item.review_id ?? null,
        text: item.text,
        rating: item.rating ?? null,
      })),
    };

    try {
      const response = await fetch(`${API_URL}/predict/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `HTTP ${response.status}: ${errorBody.slice(0, 300)}`
        );
      }

      const data = await response.json();
      signal?.throwIfAborted();

      if (!Array.isArray(data.results)) {
        throw new Error("API không trả về danh sách kết quả hợp lệ.");
      }

      results.push(...data.results);

      // Chuyển index loại bỏ từ phạm vi batch
      // sang vị trí tương ứng trong danh sách đầu vào.
      for (const row of data.rejected || []) {
        rejected.push({
          ...row,
          index: start + row.index,
        });
      }

      processed += batch.length;
      void logActivity("analysis_batch_completed", context, {
        batch: batchNumber, submitted: batch.length,
        completed: data.results.filter(row => row.status === "ok").length
      }, performance.now() - started);

      onProgress({
        processed,
        total,
        percent: Math.round((processed / total) * 100),
        completedReviews: results.length,
      });

    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw error;
      void logActivity("analysis_batch_failed", context, {
        batch: batchNumber, error_type: error.name || "Error"
      }, performance.now() - started);
      batchError = error.message;
      break;
    }
  }

  return {
    product_id: productId,
    model: "NB39+NB46+NB04",
    source: "unified",
    requested: total,
    submitted: processed,
    completed: results.filter(
      (item) => item.status === "ok"
    ).length,
    failed: results.filter(
      (item) => item.status !== "ok"
    ).length,
    rejected,
    results,
    stopped_early: processed < total,
    error: batchError,
  };
}

/**
 * Tạo thống kê sơ bộ trên các dự đoán đã nhận.
 * Mỗi aspect được tính một lần theo category gốc.
 * Chưa thực hiện ánh xạ category giữa hai bộ dữ liệu.
 */
export function summarizeABSA(batchResult) {
  const sentiments = {
    positive: 0,
    neutral: 0,
    negative: 0,
  };

  const categories = {};
  let reviewsWithAspects = 0;

  for (const review of batchResult.results) {
    if (review.status !== "ok") continue;

    const aspects = Array.isArray(review.aspects)
      ? review.aspects
      : [];

    if (aspects.length) reviewsWithAspects++;

    for (const aspect of aspects) {
      const sentiment = String(aspect.sentiment || "")
        .toLowerCase();

      const category = String(aspect.category || "UNKNOWN");

      if (!(sentiment in sentiments)) continue;

      sentiments[sentiment]++;

      if (!categories[category]) {
        categories[category] = {
          positive: 0,
          neutral: 0,
          negative: 0,
        };
      }

      categories[category][sentiment]++;
    }
  }

  return {
    reviewsAnalyzed: batchResult.completed,
    reviewsWithAspects,
    totalAspects: Object.values(sentiments).reduce(
      (sum, count) => sum + count, 0
    ),
    sentiments,
    categories,
  };
}
