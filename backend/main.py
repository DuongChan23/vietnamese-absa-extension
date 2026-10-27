from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from .inference import ABSAPredictor

predictor=None
startup_error=None

@asynccontextmanager
async def lifespan(app:FastAPI):
    global predictor,startup_error
    try:
        predictor=ABSAPredictor()
    except Exception as ex:
        startup_error=f'{type(ex).__name__}: {ex}'
        print('MODEL NOT READY:',startup_error)
    yield

app=FastAPI(title='Vietnamese ABSA Local API',lifespan=lifespan)
# Developer prototype on loopback. In production set exact extension ID and enforce local authentication.
app.add_middleware(CORSMiddleware,allow_origin_regex=r'^chrome-extension://[a-p]{32}$',allow_methods=['GET','POST'],allow_headers=['Content-Type'],allow_credentials=False)

class PredictRequest(BaseModel):
    text:str=Field(min_length=1,max_length=3000)
    source:str=Field(default='unified',min_length=1,max_length=100)

@app.get('/health')
def health():
    return {'ready':predictor is not None,'error':startup_error if predictor is None else None,
            'sources':list(predictor.categories) if predictor else [], 'unified_available':predictor is not None}

@app.post('/predict')
def predict(req:PredictRequest):
    if predictor is None:
        raise HTTPException(status_code=503,detail=f'Model not ready: {startup_error}')
    if req.source!='unified' and req.source not in predictor.categories:
        raise HTTPException(status_code=422,detail=f'Unknown source. Allowed: {list(predictor.categories)}')
    try:
        result=predictor.predict_unified(req.text) if req.source=='unified' else predictor.predict(req.text,req.source)
        return {'source':req.source,'text':req.text,'aspects':result,'model':'NB39+NB46+NB04', 'evaluation_note':'Unified mode is experimental and was not evaluated in NB55' if req.source=='unified' else 'Source-conditioned inference as in NB55'}
    except Exception as exc:
        raise HTTPException(status_code=500,detail=f'Inference failed: {type(exc).__name__}: {exc}')
