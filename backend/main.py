"""ABSA HTTP API. Run one worker to share one model and JVM safely."""

from contextlib import asynccontextmanager
from datetime import datetime
import logging
from threading import Lock
from time import perf_counter
from typing import Annotated, Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .activity_log import activity_context, log_event
from .api_guard import APIGuard, extension_origin_pattern
from .category_normalizer import MERGE_POLICY, merge_aspects
from .inference_reuse import ExactPredictionCache
from .inference_runtime import InputTooLongError
from .preprocessing import prepare_reviews

logger = logging.getLogger(__name__)
predictor = None
startup_error = None
inference_lock = Lock()
MODEL_NAME = "NB39+NB46+NB04"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global predictor, startup_error
    try:
        from .inference import ABSAPredictor

        started = perf_counter()
        log_event('model_loading_started')
        predictor = ABSAPredictor()
        startup_error = None
        log_event('model_loading_completed', duration_ms=(perf_counter() - started) * 1000,
                  runtime=predictor.runtime_info())
    except Exception as exc:
        predictor = None
        startup_error = 'model_not_ready'
        logger.exception('Model startup failed')
        log_event('model_loading_failed', error_type=type(exc).__name__)
    yield


app = FastAPI(title="Vietnamese ABSA API", lifespan=lifespan)
app.add_middleware(APIGuard)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=extension_origin_pattern(),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    allow_credentials=False,
)

Identifier = Annotated[str, Field(max_length=100)]
DetailValue = Annotated[str, Field(max_length=200)] | int | Annotated[
    float, Field(allow_inf_nan=False)
] | bool | None


class AnalysisRequest(BaseModel):
    run_id: Identifier | None = None
    product_id: Identifier | None = None
    source: str = Field(default="unified", min_length=1, max_length=100)


class PredictRequest(AnalysisRequest):
    text: str = Field(min_length=1, max_length=3000, pattern=r'^[^\x00]*[^\s\x00][^\x00]*$')


class BatchPredictRequest(AnalysisRequest):
    reviews: list[dict[str, Any] | str] = Field(min_length=1, max_length=30)


class ActivityLogRequest(BaseModel):
    event_id: Identifier | None = None
    event: str = Field(pattern=r'^[a-z][a-z0-9_]{0,63}$')
    run_id: Identifier | None = None
    product_id: Identifier | None = None
    client_time: datetime | None = None
    duration_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    details: dict[Annotated[str, Field(max_length=64)], DetailValue] = Field(
        default_factory=dict, max_length=30
    )


class ActivityLogBatchRequest(BaseModel):
    events: list[ActivityLogRequest] = Field(min_length=1, max_length=100)


def get_predictor():
    if predictor is None:
        raise HTTPException(status_code=503, detail='model_not_ready')
    return predictor


def validate_source(source, model):
    if source != "unified" and source not in model.categories:
        raise HTTPException(status_code=422, detail=f"Unknown source. Allowed: {['unified', *model.categories]}")


def run_inference(text, source, model, *, run_id=None, product_id=None):
    with inference_lock, activity_context(run_id=run_id, product_id=product_id):
        return model.predict_unified(text) if source == "unified" else model.predict(text, source)


def response_metadata(source):
    return {
        'source': source,
        'model': MODEL_NAME,
        'evaluation_note': (
            'Unified mode is experimental and was not evaluated in NB55'
            if source == 'unified' else 'Source-conditioned inference as in NB55'
        ),
        'category_merge_policy': MERGE_POLICY,
    }


@app.get('/health')
def health():
    runtime = predictor.runtime_info() if predictor and hasattr(predictor, 'runtime_info') else None
    return {
        'api_version': '0.3.4',
        'inference_runtime': {key: value for key, value in runtime.items() if key != 'java_home'} if runtime else None,
        'activity_log': {'enabled': True, 'endpoint': '/activity/log', 'batch_endpoint': '/activity/log/batch'},
        'ready': predictor is not None,
        'error': startup_error if predictor is None else None,
        'sources': list(predictor.categories) if predictor else [],
        'unified_available': predictor is not None,
        'category_merge_available': True,
        'category_merge_policy': MERGE_POLICY,
    }


@app.post('/activity/log')
def record_activity(req: ActivityLogRequest):
    if not log_event(
        req.event, run_id=req.run_id, product_id=req.product_id,
        duration_ms=req.duration_ms, origin='extension',
        client_time=req.client_time.isoformat() if req.client_time else None,
        client_details=req.details, client_event_id=getattr(req, 'event_id', None),
    ):
        raise HTTPException(status_code=503, detail='activity_log_unavailable')
    return {'ok': True}


@app.post('/activity/log/batch')
def record_activity_batch(req: ActivityLogBatchRequest):
    for event in req.events:
        record_activity(event)
    return {'ok': True, 'written': len(req.events)}


@app.post('/predict')
def predict(req: PredictRequest):
    model = get_predictor()
    validate_source(req.source, model)
    run_id = req.run_id or str(uuid4())
    started = perf_counter()
    context = dict(run_id=run_id, product_id=req.product_id)
    log_event('single_analysis_started', **context, source=req.source, text_chars=len(req.text))
    try:
        aspects = run_inference(req.text, req.source, model, **context)
        merged = merge_aspects(aspects)
        log_event('single_analysis_completed', **context, duration_ms=(perf_counter() - started) * 1000,
                  aspects=len(aspects), merged_aspects=len(merged))
        return {**response_metadata(req.source), 'text': req.text, 'aspects': aspects, 'aspects_merged': merged}
    except InputTooLongError as exc:
        log_event('single_analysis_failed', **context, duration_ms=(perf_counter() - started) * 1000,
                  error_type='text_exceeds_model_context')
        raise HTTPException(status_code=422, detail='text_exceeds_model_context') from exc
    except Exception as exc:
        logger.exception('Single inference failed: run_id=%s', run_id)
        log_event('single_analysis_failed', **context, duration_ms=(perf_counter() - started) * 1000,
                  error_type=type(exc).__name__)
        raise HTTPException(status_code=500, detail='inference_failed') from exc


@app.post('/predict/batch')
def predict_batch(req: BatchPredictRequest):
    model = get_predictor()
    validate_source(req.source, model)
    context = dict(run_id=req.run_id or str(uuid4()), product_id=req.product_id, batch_id=str(uuid4()))
    started = perf_counter()
    log_event('batch_analysis_started', **context, reviews=len(req.reviews), source=req.source)
    prepared = prepare_reviews(req.reviews, product_id=req.product_id)
    log_event('batch_preprocessing_completed', **context, duration_ms=(perf_counter() - started) * 1000,
              accepted=prepared['stats']['accepted'], rejected=prepared['stats']['rejected'])
    cache = ExactPredictionCache(lambda text, source: run_inference(
        text, source, model, run_id=context['run_id'], product_id=req.product_id
    ))
    results = []
    seen_texts = set()
    for review in prepared['reviews']:
        text = review['text']
        tick = perf_counter()
        fields = {**context, 'review_id': review['review_id']}
        row = {**review, 'status': 'error', 'aspects': [], 'aspects_merged': []}
        try:
            if len(text) > 3000:
                row['error'] = 'text_too_long'
            else:
                log_event('review_analysis_started', **fields, text_chars=len(text), cache_hit=text in seen_texts)
                with activity_context(**fields):
                    aspects = cache.predict(text, req.source)
                row.update(status='ok', aspects=aspects, aspects_merged=merge_aspects(aspects))
                seen_texts.add(text)
        except InputTooLongError:
            row['error'] = 'text_exceeds_model_context'
        except Exception:
            logger.exception('Batch inference failed: run_id=%s review_id=%s', context['run_id'], review['review_id'])
            row['error'] = 'inference_failed'
        if row['status'] == 'ok':
            log_event('review_analysis_completed', **fields, duration_ms=(perf_counter() - tick) * 1000,
                      aspects=len(row['aspects']), merged_aspects=len(row['aspects_merged']))
        else:
            log_event('review_analysis_failed', **fields, duration_ms=(perf_counter() - tick) * 1000,
                      error_type=row['error'])
        results.append(row)
    completed = sum(row['status'] == 'ok' for row in results)
    log_event('batch_analysis_completed', **context, duration_ms=(perf_counter() - started) * 1000,
              completed=completed, failed=len(results) - completed)
    return {
        **response_metadata(req.source), 'product_id': req.product_id,
        'preprocessing': prepared['stats'], 'rejected': prepared['rejected'], 'results': results,
    }
