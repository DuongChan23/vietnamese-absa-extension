
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .inference import ABSAPredictor
from .preprocessing import prepare_reviews


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
    text: str = Field(min_length=1, max_length=3000)
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
    if source != "unified" and source not in model.categories:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown source. "
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
# 5. HEALTH CHECK
# ============================================================

@app.get("/health")
def health():
    return {
        "ready": predictor is not None,
        "error": startup_error if predictor is None else None,
        "sources": list(predictor.categories) if predictor else [],
        "unified_available": predictor is not None,
    }


# ============================================================
# 6. SINGLE REVIEW INFERENCE
# ============================================================

@app.post("/predict")
def predict(req: PredictRequest):
    model = get_predictor()
    validate_source(req.source, model)

    try:
        aspects = run_inference(req.text, req.source, model)

        return {
            "source": req.source,
            "text": req.text,
            "aspects": aspects,
            "model": "NB39+NB46+NB04",
            "evaluation_note": get_evaluation_note(req.source),
        }

    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Inference failed: "
                f"{type(exc).__name__}: {exc}"
            ),
        )


# ============================================================
# 7. BATCH REVIEW INFERENCE
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

        if len(text) > 3000:
            results.append({
                **review,
                "status": "error",
                "aspects": [],
                "error": "text_too_long",
            })
            continue

        try:
            aspects = run_inference(
                text,
                req.source,
                model,
            )

            results.append({
                **review,
                "status": "ok",
                "aspects": aspects,
            })

        except Exception as exc:
            results.append({
                **review,
                "status": "error",
                "aspects": [],
                "error": type(exc).__name__,
            })

    # Step 3: Return individual predictions and cleaning stats.
    return {
        "source": req.source,
        "product_id": req.product_id,
        "model": "NB39+NB46+NB04",
        "evaluation_note": get_evaluation_note(req.source),
        "preprocessing": prepared["stats"],
        "rejected": prepared["rejected"],
        "results": results,
    }
