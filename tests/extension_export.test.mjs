import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnalysisExport,
  createExportFilename,
  downloadJsonFile,
} from "../extension/services/export_service.js";

test("export preserves source taxonomy, original reviews, raw predictions, and review-to-result identity", () => {
  const reviews = [
    { review_id: "r-1", product_id: "shop.item", text: "Dịch vụ tốt", rating: 5, created_at: "2026-11-23" },
    { review_id: "r-2", product_id: "shop.item", text: "Dịch vụ tốt", rating: 4, created_at: "2026-11-22" },
    { review_id: "r-3", product_id: "shop.item", text: "Giao hàng chậm", rating: 2 },
  ];
  const rawPredictions = [
    { review_id: "r-2", text: "Dịch vụ tốt", status: "ok", aspects: [{ category: "SER&ACC", sentiment: "positive" }], aspects_merged: [{ category: "SER&ACC", sentiment: "positive" }] },
    { review_id: "r-1", text: "Dịch vụ tốt", status: "ok", aspects: [{ category: "Service", sentiment: "positive" }], aspects_merged: [{ category: "Service", sentiment: "positive" }] },
  ];
  const payload = buildAnalysisExport({
    exportedAt: "2026-11-23T12:00:00.000Z",
    extensionVersion: "0.3.4",
    product: { product_id: "shop.item", name: "Áo Coolmate", category_path: ["Thời Trang", "Áo"] },
    selectedSource: "vicloabsa",
    run: { run_id: "run-1", product_id: "shop.item", started_at: "2026-11-23T11:00:00.000Z", source: "vicloabsa", domain_detection: { source: "vicloabsa", confidence: 0.98, method: "shopee_category" } },
    collection: { platform: "shopee", product_id: "shop.item", stats: { pages_checked: 2 } },
    reviews,
    batchResult: {
      product_id: "shop.item", source: "vicloabsa", model: "NB39+NB46+NB04",
      requested: 3, submitted: 3, completed: 2, failed: 0, stopped_early: false,
      category_merge_policy: "source_preserving_exact_duplicate_v1",
      results: rawPredictions,
      rejected: [{ index: 2, reason: "input_rejected" }],
    },
    analytics: { totalAspects: 2, categories: [{ name: "SER&ACC", total: 1 }, { name: "Service", total: 1 }] },
  });

  assert.equal(payload.schema, "vietnamese-absa-extension.analysis-export");
  assert.equal(payload.schema_version, "1.0.0");
  assert.equal(payload.domain.selected_source, "vicloabsa");
  assert.equal(payload.domain.detection.confidence, 0.98);
  assert.equal(payload.analysis.category_merge_policy, "source_preserving_exact_duplicate_v1");
  assert.equal(payload.reviews.length, 3);
  assert.equal(payload.reviews[0].prediction.aspects_merged[0].category, "Service");
  assert.equal(payload.reviews[1].prediction.aspects_merged[0].category, "SER&ACC");
  assert.equal(payload.reviews[2].analysis_status, "rejected");
  assert.equal(payload.reviews[2].rejection.reason, "input_rejected");
  assert.equal(payload.analysis.raw_predictions.length, 2);
  assert.deepEqual(payload.reviews[0].raw_review, reviews[0]);
  assert.equal(payload.product.category_path[1], "Áo");
});

test("export falls back to ordered text matching only when review IDs are unavailable", () => {
  const payload = buildAnalysisExport({
    reviews: [{ text: "trùng" }, { text: "trùng" }],
    batchResult: {
      source: "visd4sa",
      results: [
        { text: "trùng", status: "ok", aspects: [{ category: "CAMERA" }] },
        { text: "trùng", status: "error", error: "inference_failed" },
      ],
    },
  });
  assert.equal(payload.reviews[0].analysis_status, "ok");
  assert.equal(payload.reviews[1].analysis_status, "error");
  assert.equal(payload.domain.selected_source, "visd4sa");
});

test("export filename is filesystem-safe and identifies the product and time", () => {
  assert.equal(
    createExportFilename("123.456", new Date("2026-11-23T12:34:56.000Z")),
    "shopee-absa-123_456-2026-11-23T12-34-56-000Z.json",
  );
});

test("download helper creates a UTF-8 JSON Blob and revokes its temporary URL", () => {
  let downloaded = null;
  let revoked = null;
  let scheduledDelay = null;
  const anchor = {
    click() { downloaded = { href: this.href, filename: this.download }; },
    remove() { this.removed = true; },
  };
  const documentRef = { body: { appendChild(node) { node.appended = true; } }, createElement: () => anchor };
  const URLRef = {
    createObjectURL(blob) { assert.equal(blob.type, "application/json;charset=utf-8"); return "blob:test"; },
    revokeObjectURL(url) { revoked = url; },
  };
  const result = downloadJsonFile({ text: "áo" }, "result.json", {
    documentRef, URLRef, BlobRef: Blob,
    setTimeout(callback, delay) { scheduledDelay = delay; callback(); },
  });
  assert.deepEqual(downloaded, { href: "blob:test", filename: "result.json" });
  assert.equal(anchor.removed, true);
  assert.equal(revoked, "blob:test");
  assert.equal(scheduledDelay, 1000);
  assert.ok(result.size_bytes > 0);
});
