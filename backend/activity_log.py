"""Rotating JSONL timings shared by the extension and local inference API."""

from datetime import datetime, timezone
from contextlib import contextmanager
from contextvars import ContextVar
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from threading import Lock

LOG_PATH = Path(__file__).resolve().parents[1] / 'logs' / 'activity.jsonl'
_logger = None
_lock = Lock()
_context = ContextVar('absa_activity_context', default={})


@contextmanager
def activity_context(**values):
    token = _context.set({**_context.get(), **values})
    try:
        yield
    finally:
        _context.reset(token)


def _get_logger():
    global _logger
    with _lock:
        if _logger is None:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            logger = logging.Logger('absa.activity', level=logging.INFO)
            handler = RotatingFileHandler(
                LOG_PATH, maxBytes=10 * 1024 * 1024, backupCount=3, encoding='utf-8'
            )
            handler.setFormatter(logging.Formatter('%(message)s'))
            logger.addHandler(handler)
            logger.propagate = False
            _logger = logger
        return _logger


def log_event(event, *, run_id=None, product_id=None, duration_ms=None, **details):
    """Callers pass IDs/counts/timings only, never review text or full URLs."""
    context = _context.get()
    record = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'event': event,
        'run_id': run_id if run_id is not None else context.get('run_id'),
        'product_id': product_id if product_id is not None else context.get('product_id'),
        'duration_ms': round(duration_ms, 3) if duration_ms is not None else None,
        'details': {**{key: value for key, value in context.items()
                       if key not in ('run_id', 'product_id')}, **details},
    }
    try:
        _get_logger().info(json.dumps(record, ensure_ascii=False, allow_nan=False))
        return True
    except (OSError, ValueError):
        return False
