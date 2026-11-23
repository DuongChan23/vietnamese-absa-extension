# Exporting Shopee ABSA results as JSON

## How to export

1. Open a Shopee product page and open the Shopee Review AI side panel.
2. Select the detected or confirmed product domain.
3. Choose a review limit and run the analysis.
4. When the dashboard appears, click **Xuất JSON** in the **Dữ liệu thực nghiệm** toolbar.
5. Save the generated `shopee-absa-<product-id>-<timestamp>.json` file.

The export is generated locally by the Extension. It is not uploaded to a server or sent to a third-party service.

## File contents

| Field | Description |
|---|---|
| `schema`, `schema_version` | Stable export identifier and format version |
| `project` | Extension name and version |
| `product` | Product metadata collected from the Shopee page, including title, price, category path and product ID when available |
| `domain` | Selected inference source and the raw domain-detection response |
| `run` | Run ID, timestamps, requested review limit, source, model and completion state |
| `collection` | Collection URL/time, pagination diagnostics, stop reason, Shopee rating summary and raw collected reviews |
| `analysis` | Model name, source, evaluation note, exact category-merge policy, per-batch preprocessing statistics, rejected inputs and raw predictions |
| `analytics` | Dashboard aggregate statistics |
| `reviews` | One row per collected review, with original review fields, matched prediction and rejection details |

## Review-level record

Each `reviews[]` row includes:

- `index`, `review_id`, `product_id`, `text`, `rating`, `created_at`: source review fields.
- `raw_review`: full original review object as collected.
- `prediction`: full backend prediction row, preserving both `aspects` and `aspects_merged` exactly as returned.
- `rejection`: preprocessing rejection details when the review was rejected.
- `analysis_status`: `ok`, `error`, `rejected` or `not_returned`.

Predictions are matched to reviews by stable `review_id` first. Ordered text matching is used only when a review has no ID. The export does not translate, merge or rename taxonomy labels. For example, `SER&ACC` and `Service` remain distinct if the backend returned them as distinct labels.

## Notes for evaluation

- A JSON export is an inference artifact, not a gold-label evaluation by itself.
- The Shopee product rating distribution is separate from sentiment predicted for collected review aspects.
- A partial run is still exportable; check `run.status` and `analysis.stopped_early` before using it for evaluation.
- `raw_predictions` preserves backend rows, while `reviews[]` provides convenient review-to-prediction pairing.
- Keep the export unchanged as an experiment artifact. Create separate derived files/scripts for cleaning, matching with Gold Label, or computing Precision/Recall/F1.
