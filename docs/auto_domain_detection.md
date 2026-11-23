# Auto Domain Detection

## Purpose

The Extension detects the product domain before ABSA inference and routes each review to exactly one source taxonomy:

- **ViCloABSA / vicloabsa**: fashion and clothing products.
- **ViSD4SA / visd4sa**: phones and electronics.

The detector does not alter NB39, NB46, NB04, model weights, preprocessing, spans, sentiment predictions, or the source taxonomy labels. The selected source is sent to the existing /predict/batch endpoint.

## Runtime flow

1. product_collector.js extracts the product name, description, JSON-LD/DOM breadcrumb, and category IDs when present.
2. The Extension sends this metadata to POST /domain/detect.
3. backend/domain_classifier.py evaluates verified category metadata first, then product-name and description rules.
4. If a local classifier is explicitly configured, it is used as a fallback for uncertain cases.
5. The Extension automatically accepts only a result at or above the automatic threshold. Medium-confidence results require the user to select/confirm a domain. Unknown or contradictory products require manual selection.
6. batch_service.js sends the selected source with every batch and rejects a response whose source does not match the request.

## Decision thresholds

| Score | Status | Extension behavior |
|---|---|---|
| 0.90–1.00 | auto_detected | Select the source automatically |
| 0.65–0.899 | confirmation_required | Show the recommendation; user must confirm/select |
| Below 0.65 or conflicting evidence | unknown | Do not run inference until the user selects a domain |

Rule-based scores are heuristic confidence scores, not statistically calibrated probabilities. They must be calibrated on a labeled product validation set before being interpreted as probabilities. For `confirmation_required`, the API returns `source: null` and places the recommendation in `suggested_source`; the Extension must not treat the suggestion as selected until the user confirms it.

## Category ID mapping

No numeric Shopee category IDs are hard-coded because they have not yet been verified from live product pages. After collecting and checking real IDs, an optional JSON mapping can be supplied through the environment variable ABSA_DOMAIN_CATEGORY_ID_MAP.

Example value:
{"<verified_category_id>":"vicloabsa","<another_verified_category_id>":"visd4sa"}

Only verified IDs should be added. Category names and breadcrumbs continue to work when no ID mapping is configured.

## Optional local AI fallback

No trained product-domain classifier artifact is currently included in this repository. The implementation therefore does not claim to run an AI model by default and does not call Gemini or another remote service.

A compatible local Hugging Face sequence-classification model can be enabled by setting:
- ABSA_DOMAIN_MODEL_DIR to a local model directory.
- ABSA_DOMAIN_MODEL_LABELS to a JSON object mapping model class indices to vicloabsa and visd4sa, for example {"0":"vicloabsa","1":"visd4sa"}.

The model must already exist locally. The backend uses local_files_only=True; it will not download weights. If the model is missing, invalid, or returns unsupported labels, detection safely falls back to rules and manual selection.

## Validation

Run from the repository root:
- Python: python -m unittest discover -s tests
- Extension: node --test tests/*.test.mjs

The product-domain validation set should include labeled examples from both domains and out-of-scope products. Report a confusion matrix, per-domain precision/recall/F1, overall accuracy, and the unknown/confirmation rates. Do not tune thresholds on NB55 DEV/TEST or the ABSA Gold Label review set.

## Safety behavior

- Conflicting category and product-name evidence returns unknown.
- Brand-only evidence is not auto-accepted.
- Unrecognized categories do not silently default to clothing.
- A missing detector endpoint or older backend leaves manual selection available.
- The API requires an explicit source; there is no implicit unified default.
- unified remains an explicit experimental API mode only and is not used by the Extension.
