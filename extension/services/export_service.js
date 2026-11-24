"use strict";

function cloneJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.parse(JSON.stringify(value));
}

function pushQueue(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function takeQueue(map, key) {
  const queue = map.get(key);
  return queue?.length ? queue.shift() : null;
}

export function buildAnalysisExport({
  exportedAt = new Date().toISOString(),
  extensionVersion = null,
  product = null,
  selectedSource = null,
  run = null,
  collection = null,
  reviews = [],
  batchResult = null,
  analytics = null,
} = {}) {
  const collected = Array.isArray(reviews) ? reviews : [];
  const predictions = Array.isArray(batchResult?.results) ? batchResult.results : [];
  const rejected = Array.isArray(batchResult?.rejected) ? batchResult.rejected : [];
  const predictionsById = new Map();
  const predictionsByText = new Map();

  for (const prediction of predictions) {
    if (!prediction || typeof prediction !== "object") continue;
    if (prediction.review_id !== null && prediction.review_id !== undefined) {
      pushQueue(predictionsById, String(prediction.review_id), prediction);
    } else {
      pushQueue(predictionsByText, String(prediction.text ?? ""), prediction);
    }
  }

  const rejectedByIndex = new Map();
  for (const item of rejected) {
    if (Number.isInteger(item?.index)) rejectedByIndex.set(item.index, item);
  }

  const reviewRows = collected.map((review, index) => {
    const prediction = review?.review_id !== null && review?.review_id !== undefined
      ? takeQueue(predictionsById, String(review.review_id))
      : takeQueue(predictionsByText, String(review?.text ?? ""));
    const rejection = rejectedByIndex.get(index) ?? null;

    return {
      index: index + 1,
      review_id: review?.review_id ?? null,
      product_id: review?.product_id ?? batchResult?.product_id ?? collection?.product_id ?? null,
      text: review?.text ?? "",
      rating: review?.rating ?? null,
      created_at: review?.created_at ?? null,
      analysis_status: prediction?.status ?? (rejection ? "rejected" : "not_returned"),
      raw_review: cloneJson(review),
      prediction: cloneJson(prediction),
      rejection: cloneJson(rejection),
    };
  });

  const source = batchResult?.source ?? selectedSource ?? run?.source ?? null;
  const model = batchResult?.model ?? run?.model ?? null;

  return {
    schema: "vietnamese-absa-extension.analysis-export",
    schema_version: "1.0.0",
    exported_at: exportedAt,
    project: {
      name: "Shopee Review AI",
      extension_version: extensionVersion,
    },
    platform: collection?.platform ?? "shopee",
    product: cloneJson(product) ?? {
      product_id: batchResult?.product_id ?? collection?.product_id ?? null,
    },
    domain: {
      selected_source: source,
      label: source === "vicloabsa"
        ? "Thời trang / Quần áo (ViCloABSA)"
        : source === "visd4sa"
          ? "Điện thoại / Điện tử (ViSD4SA)"
          : null,
      detection: cloneJson(run?.domain_detection),
    },
    run: {
      run_id: run?.run_id ?? collection?.run_id ?? null,
      product_id: run?.product_id ?? batchResult?.product_id ?? collection?.product_id ?? null,
      started_at: run?.started_at ?? null,
      finished_at: run?.finished_at ?? null,
      requested_review_limit: run?.requested_review_limit ?? null,
      source,
      model,
      status: run?.status ?? (batchResult?.stopped_early ? "partial" : "completed"),
      error: run?.error ?? batchResult?.error ?? null,
    },
    collection: {
      ...cloneJson(collection ?? {}),
      review_count: collected.length,
      reviews: reviewRows.map(row => cloneJson(row.raw_review)),
    },
    analysis: {
      model,
      source,
      evaluation_note: batchResult?.evaluation_note ?? null,
      category_merge_policy: batchResult?.category_merge_policy ?? null,
      preprocessing_batches: cloneJson(batchResult?.preprocessing_batches ?? []),
      requested: batchResult?.requested ?? collected.length,
      submitted: batchResult?.submitted ?? 0,
      completed: batchResult?.completed ?? predictions.filter(row => row?.status === "ok").length,
      failed: batchResult?.failed ?? predictions.filter(row => row?.status === "error").length,
      stopped_early: Boolean(batchResult?.stopped_early),
      error: batchResult?.error ?? null,
      rejected: cloneJson(rejected),
      prediction_count: predictions.length,
      raw_predictions: cloneJson(predictions),
    },
    analytics: cloneJson(analytics),
    reviews: reviewRows,
  };
}

export function createExportFilename(productId, date = new Date()) {
  const safeProductId = String(productId ?? "product")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "product";
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  return "shopee-absa-" + safeProductId + "-" + timestamp + ".json";
}

export function downloadJsonFile(payload, filename, environment = {}) {
  const documentRef = environment.documentRef ?? document;
  const URLRef = environment.URLRef ?? URL;
  const BlobRef = environment.BlobRef ?? Blob;
  const schedule = environment.setTimeout ?? globalThis.setTimeout;
  const json = JSON.stringify(payload, null, 2);
  const blob = new BlobRef([json], { type: "application/json;charset=utf-8" });
  const objectUrl = URLRef.createObjectURL(blob);
  const anchor = documentRef.createElement("a");

  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  documentRef.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  schedule(() => URLRef.revokeObjectURL(objectUrl), 1000);

  return { filename, size_bytes: new BlobRef([json]).size };
}
