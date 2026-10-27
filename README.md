# Vietnamese ABSA — Chrome Extension + FastAPI

A local prototype of a **Vietnamese aspect-based sentiment analysis (ABSA)** system, trained using data prepared from **UIT-ViSD4SA** and **ViCloABSA**. Chrome Extension communicates with a Python FastAPI backend that loads the locally stored trained checkpoints.

> **Status (2026-10-27):** The local Windows inference path and the `unified` endpoint have been successfully tried with a Vietnamese phone review. This is a research prototype, **not a production-ready review crawler**. Automated retrieval of Shopee reviews is **not yet implemented**. The frontend is temporary.

## Architecture

```text
Chrome Side Panel (Manifest V3)
         |
         | POST http://127.0.0.1:8000/predict
         v
     FastAPI backend
         |
         +--> NB39: XLM-R Joint Biaffine (aspect spans + category candidates)
         +--> NB46: Whole-span Boundary Reranker (candidate re-ranking)
         +--> NB04: PhoBERT ASC (sentiment for selected spans)
         |
         v
    JSON: aspect, offsets, category, sentiment
```

**NB20** is a training-stage ancestor of NB39, and its exported model directory supplies the tokenizer and configuration to the local backend. **NB55** is the unified offline evaluation notebook; it does **not** produce a new set of model weights. This repository reimplements inference rather than running NB55 itself.

## Research pipeline and results

| Notebook | Responsibility |
|---|---|
| NB01 | Normalize and clean the two datasets |
| NB04 | Train PhoBERT Aspect Sentiment Classification |
| NB20 | Train category-conditioned XLM-R extractor |
| NB39 | Train Joint Biaffine extractor based on NB20 |
| NB46 | Train frozen-NB39 residual boundary reranker |
| NB55 | Evaluate Full ABSA Baseline versus Proposed on DEV |

**NB55 DEV results from the completed Colab run** (exact-span, category and sentiment evaluation; source-aware evaluation, *not* unified mode):

| Metric | Baseline (NB39 + NB04) | Proposed (NB39 + NB46 + NB04) |
|---|---:|---:|
| Span F1 | 66.349% | 66.768% |
| Span + Category F1 | 64.263% | 64.826% |
| Span + Sentiment F1 | 63.657% | 64.140% |
| **Full ABSA F1** | **61.708%** | **62.315%** |

Proposed improves DEV Full ABSA F1 by approximately **+0.608 percentage points** (displayed values are rounded). DEV has been used repeatedly during development; this is **not an untouched TEST score**.

### About `source: "unified"`

The category-conditioned extractor was evaluated in NB55 with a **known dataset source** per review. The local app provides an **experimental** `unified` mode that runs category queries for both datasets and combines exactly matching predictions. This mode has **not been evaluated with the NB55 F1 protocol**, and category synonyms across datasets are **not semantically normalized** yet. Do not cite 62.315% as a metric for `unified` mode.

## Project structure

```text
backend/
  main.py                  # FastAPI: /health, /predict
  inference.py             # Load local checkpoints and perform proposed inference
  requirements.txt
extension/
  manifest.json            # Chrome Manifest V3
  background.js            # Side Panel interaction
  popup.html               # Prototype UI, not final design
  popup.css
  popup.js
models/                     # Local checkpoints (excluded from Git)
vncorenlp/                  # Local word segmentation assets (excluded from Git)
experimental/
  shopee_modules/           # Draft modules for product/review batch processing; NOT deployed
```

## Prerequisites

- Windows 10/11 (tested by the project owner with Python **3.11.9**)
- Python 3.11 and Java 21 (local machine reported Java **21.0.2**)
- Chrome with support for Manifest V3 Side Panel
- Trained checkpoints exported from your own Colab/Drive; **not included in this repo**
- VnCoreNLP 1.2 resources (`wseg`)

## Local setup on Windows (CMD)

```bat
cd /d C:\Users\Admin\Downloads\vietnamese-absa-extension
py -3.11 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install -r backend\requirements.txt
python -m pip install torch protobuf
```

Use a PyTorch build suitable for your machine. The local run in this project used a CPU build; CUDA was unavailable.

### Add local model artifacts

Download your **own** files from the Google Drive `/ABSA/exports/` structure:

```text
models/
├── ate_category_conditioned_v1/
│   └── model/
│       ├── conditional_span.pt
│       ├── model_config.json
│       └── [all tokenizer files]
├── absa_joint_biaffine_span_pair_v1/
│   ├── joint_best.pt
│   └── locked_policy.json
├── absa_joint46_boundary_ranking_pilot_v1/
│   ├── reranker_best.pt
│   └── pilot_policy.json
└── phobert_asc_training/
    └── model/
        ├── model.safetensors
        ├── config.json
        ├── bpe.codes
        ├── vocab.txt
        └── [other tokenizer files]
```

Check SHA-256 of key checkpoints before startup:

| Artifact | Expected SHA-256 |
|---|---|
| NB20 `conditional_span.pt` | `775be14671de87c03ef228b19ef199f70f70a57b000463f382f517137f1b2944` |
| NB39 `joint_best.pt` | `b32923b7e9db9713354ccaaad4b21390ce621f34ddeeb4d9d37a0e65722c5262` |
| NB46 `reranker_best.pt` | `49f60b8027c0dce029f72365bb2c3de5bd4587e5f65cdede593374cd4bae242b` |

The project code also validates that NB46's `base_checkpoint_sha256` matches NB39.

### VnCoreNLP on Windows

The `py_vncorenlp.download_model` helper may require `wget` and can fail in Windows CMD. Download the official files into the following layout instead:

```text
vncorenlp/
  VnCoreNLP-1.2.jar
  models/
    wordsegmenter/
      vi-vocab
      wordsegmenter.rdr
```

Official repository: https://github.com/vncorenlp/VnCoreNLP

Confirm it works:

```bat
python -c "import py_vncorenlp,os; p=os.path.abspath('vncorenlp'); m=py_vncorenlp.VnCoreNLP(annotators=['wseg'],save_dir=p); print(m.word_segment('Điện thoại có màn hình đẹp nhưng pin rất yếu.'))"
```

### Run the backend

```bat
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

- Health: http://127.0.0.1:8000/health (check `ready: true`)
- Interactive API: http://127.0.0.1:8000/docs

Example `/predict` request:

```json
{
  "text": "Điện thoại có màn hình đẹp nhưng pin rất yếu.",
  "source": "unified"
}
```

The observed local smoke test returned two aspects (`SCREEN`/positive and `BATTERY`/negative). Predictions are model outputs and may include overly broad aspect spans.

### Load Chrome Extension

1. Navigate to `chrome://extensions` and enable Developer Mode.
2. Use **Load unpacked** and select this repository's **`extension/`** directory.
3. Open the extension's side panel and analyze text while the FastAPI server is running.

The extension UI is only a test harness; the final product UI has not yet been designed.

## Shopee and product analytics — planned, not yet shipped

Requested next step: analyze **many reviews for a whole product**, rather than manually highlighting one review at a time.

`experimental/shopee_modules/` contains **draft, not-yet-integrated** components for input validation and review batch/product analytics. These files are kept separate from the working backend because they have not been tested on the owner's Windows installation. **No automatic Shopee review collector is in this version.** Any future integration must respect website permissions and access limits; do not assume access to hidden reviews or unofficial endpoints.

## Reproducibility and known limitations

- Model checkpoints and VnCoreNLP assets are excluded from Git by `.gitignore` because they are large and/or have separate distribution terms.
- The baseline NB55 DEV run and its prediction exports are **not stored in this repository**; they remain in the owner's Drive exports. Optionally use them in a private `tests/reference/` folder to check parity.
- NB01 audit indicated **5 annotation conflicts pending manual review** (`passed_with_review_pending`).
- `unified` mode has not been benchmarked against gold labels.
- Automated Shopee extraction, batch analysis integration, public hosting, authentication/hardening, and production UI remain planned work.
- This project does not call Gemini API for local inference. A future evaluation against Gemini must use the same TEST protocol and evaluator.

## Roadmap

1. Add tests that compare local FastAPI predictions against saved NB55 source-aware DEV predictions.
2. Add authorized review ingestion and stable batch-analysis API, then integrate the Shopee module.
3. Evaluate unified-category behavior separately and map equivalent categories with a validated taxonomy.
4. Evaluate the locked models on an untouched TEST split and (optionally) compare with Gemini under the same criteria.
5. Design a production Chrome Side Panel interface.

## License

No license has been selected yet. Do not assume permission to redistribute model weights, pretrained assets, or source datasets.
