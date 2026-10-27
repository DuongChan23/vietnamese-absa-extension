
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .inference import ABSAPredictor
from .preprocessing import prepare_reviews
from .category_normalizer import merge_aspects


# ============================================================
# 1. MODEL LIFECYCLE
# ============================================================

predictor = None
startup_error = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global predictor, startup_error

    try:
        predictor = ABSAPredictor()
        startup_error = None

    except Exception as exc:
        predictor = None
        startup_error = f"{type(exc).__name__}: {exc}"
        print("MODEL NOT READY:", startup_error)

    yield


# ============================================================
# 2. FASTAPI APPLICATION
# ============================================================

app = FastAPI(
    title="Vietnamese ABSA Local API",
    lifespan=lifespan,
)

# Local Chrome Extension prototype
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    allow_credentials=False,
)


# ============================================================
# 3. REQUEST SCHEMAS
# ============================================================

class PredictRequest(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=3000,
    )

    source: str = Field(
        default="unified",
        min_length=1,
        max_length=100,
    )


class BatchPredictRequest(BaseModel):
    reviews: list[dict[str, Any] | str] = Field(
        min_length=1,
        max_length=30,
    )

    source: str = Field(
        default="unified",
        min_length=1,
        max_length=100,
    )

    product_id: str | None = None


# ============================================================
# 4. SHARED HELPERS
# ============================================================

def get_predictor():
    if predictor is None:
        raise HTTPException(
            status_code=503,
            detail=f"Model not ready: {startup_error}",
        )

    return predictor


def validate_source(source: str, model):
    if (
        source != "unified"
        and source not in model.categories
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                "Unknown source. "
                f"Allowed: {list(model.categories)}"
            ),
        )


def run_inference(text: str, source: str, model):
    if source == "unified":
        return model.predict_unified(text)

    return model.predict(text, source)


def get_evaluation_note(source: str) -> str:
    if source == "unified":
        return (
            "Unified mode is experimental "
            "and was not evaluated in NB55"
        )

    return "Source-conditioned inference as in NB55"


# ============================================================
# 5. CATEGORY POSTPROCESSING
# ============================================================

CATEGORY_MERGE_POLICY = (
    "case_alias_exact_span_sentiment_v1"
)


def build_merged_aspects(aspects):
    """
    Preserve original model predictions in `aspects`.

    Produce a separate normalized/deduplicated
    representation in `aspects_merged`.

    IMPORTANT:
    - Does not change AI predictions.
    - Does not modify checkpoints or thresholds.
    - Does not merge different sentiments.
    - Does not deduplicate without valid offsets.
    """

    if not isinstance(aspects, list):
        return []

    return merge_aspects(aspects)


# ============================================================
# 6. HEALTH CHECK
# ============================================================

@app.get("/health")
def health():
    return {
        "ready": predictor is not None,
        "error": (
            startup_error
            if predictor is None
            else None
        ),
        "sources": (
            list(predictor.categories)
            if predictor
            else []
        ),
        "unified_available": predictor is not None,
        "category_merge_available": True,
        "category_merge_policy": CATEGORY_MERGE_POLICY,
    }


# ============================================================
# 7. SINGLE REVIEW INFERENCE
# ============================================================

@app.post("/predict")
def predict(req: PredictRequest):
    model = get_predictor()
    validate_source(req.source, model)

    try:
        # Step 1: Original ABSA inference.
        aspects = run_inference(
            req.text,
            req.source,
            model,
        )

        # Step 2: Normalize categories and
        # deduplicate equivalent predictions.
        aspects_merged = build_merged_aspects(
            aspects
        )

        # Step 3: Preserve original predictions
        # and return merged predictions separately.
        return {
            "source": req.source,
            "text": req.text,

            "aspects": aspects,
            "aspects_merged": aspects_merged,

            "model": "NB39+NB46+NB04",
            "evaluation_note": (
                get_evaluation_note(req.source)
            ),
            "category_merge_policy": (
                CATEGORY_MERGE_POLICY
            ),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                "Inference failed: "
                f"{type(exc).__name__}: {exc}"
            ),
        )


# ============================================================
# 8. BATCH REVIEW INFERENCE
# ============================================================

@app.post("/predict/batch")
def predict_batch(req: BatchPredictRequest):
    model = get_predictor()
    validate_source(req.source, model)

    # Step 1: Validate and deduplicate reviews.
    prepared = prepare_reviews(
        req.reviews,
        product_id=req.product_id,
    )

    results = []

    # Step 2: Analyze each accepted review.
    for review in prepared["reviews"]:
        text = review["text"]

        # Keep original length protection.
        if len(text) > 3000:
            results.append({
                **review,
                "status": "error",
                "aspects": [],
                "aspects_merged": [],
                "error": "text_too_long",
            })
            continue

        try:
            # Original model inference.
            aspects = run_inference(
                text,
                req.source,
                model,
            )

            # New category normalization layer.
            aspects_merged = build_merged_aspects(
                aspects
            )

            results.append({
                **review,
                "status": "ok",

                # Raw predictions (unchanged).
                "aspects": aspects,

                # Normalized predictions.
                "aspects_merged": aspects_merged,
            })

        except Exception as exc:
            results.append({
                **review,
                "status": "error",
                "aspects": [],
                "aspects_merged": [],
                "error": type(exc).__name__,
            })

    # Step 3: Return individual predictions
    # and preprocessing statistics.
    return {
        "source": req.source,
        "product_id": req.product_id,
        "model": "NB39+NB46+NB04",
        "evaluation_note": (
            get_evaluation_note(req.source)
        ),

        # Metadata for merged categories.
        "category_merge_policy": (
            CATEGORY_MERGE_POLICY
        ),

        # Original response fields.
        "preprocessing": prepared["stats"],
        "rejected": prepared["rejected"],
        "results": results,
    }
