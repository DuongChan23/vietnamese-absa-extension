FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ABSA_MODELS_DIR=/app/models \
    ABSA_VNCORENLP_DIR=/app/vncorenlp \
    HF_HOME=/app/.cache/huggingface \
    TOKENIZERS_PARALLELISM=false \
    TMPDIR=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /tmp/backend-requirements.txt
COPY deploy/aws/constraints.txt /tmp/constraints.txt

RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch==2.10.0" \
    && python -m pip install --no-cache-dir --constraint /tmp/constraints.txt -r /tmp/backend-requirements.txt

COPY backend/ /app/backend/

RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin absa \
    && mkdir -p /app/logs /app/.cache/huggingface \
    && chown -R absa:absa /app/logs /app/.cache

USER 10001:10001
EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
