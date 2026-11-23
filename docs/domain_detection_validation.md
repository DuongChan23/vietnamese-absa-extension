# Domain Detection — Manual Validation Plan

## Validation status

The automated classifier regression fixtures cover three publicly indexed Shopee examples (Coolmate clothing, Apple iPhone 17, and Samsung Galaxy A17). They exercise the backend decision logic using supplied product names and breadcrumb paths. They do **not** prove that the Chrome Extension extracts the same breadcrumbs from the live Shopee DOM.

The optional local text-classification model is not bundled. Unless `ABSA_DOMAIN_MODEL_DIR` and its label map are configured, the detector uses category metadata and conservative text rules only.

## Test products

| Product | Expected source | Expected evidence |
|---|---|---|
| Coolmate unisex T-shirt | `vicloabsa` | Clothing / sportswear breadcrumb or a clear T-shirt product name |
| Apple iPhone 17 256GB | `visd4sa` | Phone / electronics breadcrumb or iPhone product name |
| Samsung Galaxy A17 5G | `visd4sa` | Phone breadcrumb and Samsung Galaxy product name |

Use the URLs in `tests/fixtures/shopee_domain_samples.json`. The examples were transcribed from public Shopee listing/search snippets on 2026-11-23; they are classifier fixtures, not captured browser DOM.

## Manual Chrome test

1. Merge PR #3 only after its review, then update the local checkout to the merged `main` branch and the latest PR #4 head.
2. Start the FastAPI backend using the project's existing Windows setup instructions. Confirm `GET /health` returns `ready: true` and includes `/domain/detect`.
3. Load the `extension/` folder as an unpacked Chrome Extension and open one of the Shopee product URLs above.
4. Open the Extension Side Panel. Wait for the product name and domain-detection status to appear.
5. Confirm the product name and displayed breadcrumb/category path match the Shopee page. If the breadcrumb is missing, record that separately; do not infer that extraction succeeded just because the product name matched.
6. In DevTools → Network, inspect `POST /domain/detect`. Save the request fields (`name`, `category`, `category_path`, `category_ids`) and response (`source`, `status`, `confidence`, `method`, `evidence`).
7. Run the analysis. Inspect `POST /predict/batch` and verify its `source` equals the confirmed/selected domain. The response must echo the same `source`.
8. Repeat for all three products. Then test an unrelated product such as a kitchen appliance and a brand-only title such as `Coolmate`; the detector must not silently auto-select a domain from weak evidence.

## Acceptance criteria

- Clear category metadata routes Coolmate to `vicloabsa` and phone products to `visd4sa`.
- Category/name contradictions return `unknown` and block analysis until the user chooses.
- Medium-confidence suggestions require explicit confirmation.
- Weak or unrelated metadata remains `unknown`; there is no default-to-clothing fallback.
- The selected source is identical in the UI, batch request, and API response.
- Raw ABSA predictions and source taxonomy labels are not translated or rewritten by the domain detector.

## Evidence to save

Save one JSON record per test product containing the product URL, timestamp, extracted metadata, `/domain/detect` response, selected source, and `/predict/batch` response metadata. Do not include customer review text unless it is needed for a separately approved ABSA evaluation.

## CI note

GitHub Actions currently creates the Python and Extension jobs but reports immediate failures without step summaries or downloadable job logs. A runner-smoke job has been added to distinguish runner startup problems from test failures. Until the workflow produces step logs, CI results must be treated as inconclusive rather than as code-test failures.
