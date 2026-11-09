
from contextlib import asynccontextmanager
from typing import Any
from datetime import datetime
from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .inference import ABSAPredictor
from .preprocessing import prepare_reviews
from .category_normalizer import merge_aspects
from .inference_reuse import ExactPredictionCache
from .activity_log import activity_context, log_event


# ============================================================
# 1. MODEL LIFECYCLE
# ============================================================

predictor = None
startup_error = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global predictor, startup_error

    try:
        started = perf_counter()
        log_event('model_loading_started')
        predictor = ABSAPredictor()
        startup_error = None
        log_event('model_loading_completed', duration_ms=(perf_counter()-started)*1000)

    except Exception as exc:
        predictor = None
        startup_error = f"{type(exc).__name__}: {exc}"
        print("MODEL NOT READY:", startup_error)
        log_event('model_loading_failed', error_type=type(exc).__name__)

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
    run_id: str | None = Field(default=None, max_length=100)
    product_id: str | None = Field(default=None, max_length=100)
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
    run_id: str | None = Field(default=None, max_length=100)
    reviews: list[dict[str, Any] | str] = Field(
        min_length=1,
        max_length=30,
    )

    source: str = Field(
        default="unified",
        min_length=1,
        max_length=100,
    )

    product_id: str | None = Field(default=None, max_length=100)


class ActivityLogRequest(BaseModel):
    event_id: str | None = Field(default=None, max_length=100)
    event: str = Field(pattern=r'^[a-z][a-z0-9_]{0,63}$')
    run_id: str | None = Field(default=None, max_length=100)
    product_id: str | None = Field(default=None, max_length=100)
    client_time: datetime | None = None
    duration_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    details: dict[str, str | int | float | bool | None] = Field(default_factory=dict, max_length=30)


class ActivityLogBatchRequest(BaseModel):
    events: list[ActivityLogRequest] = Field(min_length=1, max_length=100)


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


def run_inference(text: str, source: str, model, *, run_id=None, product_id=None):
    with activity_context(run_id=run_id, product_id=product_id):
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
        "api_version": "0.3.1",
        "activity_log": {
            "enabled": True,
            "endpoint": "/activity/log",
            "batch_endpoint": "/activity/log/batch",
        },
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


@app.post('/activity/log')
def record_activity(req: ActivityLogRequest):
    written = log_event(
        req.event, run_id=req.run_id, product_id=req.product_id,
        duration_ms=req.duration_ms, origin='extension',
        client_time=req.client_time.isoformat() if req.client_time else None,
        client_details=req.details,
        client_event_id=getattr(req, 'event_id', None),
    )
    if not written:
        raise HTTPException(status_code=503, detail='activity_log_unavailable')
    return {'ok': True}


@app.post('/activity/log/batch')
def record_activity_batch(req: ActivityLogBatchRequest):
    for event in req.events:
        record_activity(event)
    return {'ok': True, 'written': len(req.events)}


# ============================================================
# 7. SINGLE REVIEW INFERENCE
# ============================================================

@app.post("/predict")
def predict(req: PredictRequest):
    model = get_predictor()
    validate_source(req.source, model)
    run_id = req.run_id or str(uuid4())
    started = perf_counter()
    log_event('single_analysis_started', run_id=run_id, product_id=req.product_id,
              source=req.source, text_chars=len(req.text))

    try:
        # Step 1: Original ABSA inference.
        aspects = run_inference(
            req.text,
            req.source,
            model,
            run_id=run_id,
            product_id=req.product_id,
        )

        # Step 2: Normalize categories and
        # deduplicate equivalent predictions.
        aspects_merged = build_merged_aspects(
            aspects
        )
        log_event('single_analysis_completed', run_id=run_id, product_id=req.product_id,
                  duration_ms=(perf_counter()-started)*1000,
                  aspects=len(aspects), merged_aspects=len(aspects_merged))

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
        log_event('single_analysis_failed', run_id=run_id, product_id=req.product_id,
                  duration_ms=(perf_counter()-started)*1000, error_type=type(exc).__name__)
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
    run_id = req.run_id or str(uuid4())
    batch_id = str(uuid4())
    started = perf_counter()
    log_event('batch_analysis_started', run_id=run_id, product_id=req.product_id,
              batch_id=batch_id, reviews=len(req.reviews), source=req.source)

    # Step 1: Validate and deduplicate reviews.
    prepared = prepare_reviews(
        req.reviews,
        product_id=req.product_id,
    )
    log_event('batch_preprocessing_completed', run_id=run_id, product_id=req.product_id,
              batch_id=batch_id, duration_ms=(perf_counter()-started)*1000,
              accepted=prepared['stats']['accepted'], rejected=prepared['stats']['rejected'])

    results = []
    prediction_cache = ExactPredictionCache(
        lambda text, source: run_inference(
            text, source, model, run_id=run_id, product_id=req.product_id
        )
    )
    seen_texts = set()

    # Step 2: Analyze each accepted review.
    for review in prepared["reviews"]:
        text = review["text"]
        review_started = perf_counter()
        log_fields = dict(run_id=run_id, product_id=req.product_id,
                          batch_id=batch_id, review_id=review['review_id'])

        # Keep original length protection.
        if len(text) > 3000:
            log_event('review_analysis_failed', **log_fields, error_type='text_too_long',
                      duration_ms=(perf_counter()-review_started)*1000)
            results.append({
                **review,
                "status": "error",
                "aspects": [],
                "aspects_merged": [],
                "error": "text_too_long",
            })
            continue

        try:
            log_event('review_analysis_started', **log_fields, text_chars=len(text),
                      cache_hit=text in seen_texts)
            # Reuse only identical text; retain each review's ID/rating/order.
            with activity_context(**log_fields):
                aspects = prediction_cache.predict(
                    text,
                    req.source,
                )

            # New category normalization layer.
            aspects_merged = build_merged_aspects(
                aspects
            )
            seen_texts.add(text)
            log_event('review_analysis_completed', **log_fields,
                      duration_ms=(perf_counter()-review_started)*1000,
                      aspects=len(aspects), merged_aspects=len(aspects_merged))

            results.append({
                **review,
                "status": "ok",

                # Raw predictions (unchanged).
                "aspects": aspects,

                # Normalized predictions.
                "aspects_merged": aspects_merged,
            })

        except Exception as exc:
            log_event('review_analysis_failed', **log_fields,
                      duration_ms=(perf_counter()-review_started)*1000,
                      error_type=type(exc).__name__)
            results.append({
                **review,
                "status": "error",
                "aspects": [],
                "aspects_merged": [],
                "error": type(exc).__name__,
            })

    log_event('batch_analysis_completed', run_id=run_id, product_id=req.product_id,
              batch_id=batch_id, duration_ms=(perf_counter()-started)*1000,
              completed=sum(row['status']=='ok' for row in results),
              failed=sum(row['status']=='error' for row in results))
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
