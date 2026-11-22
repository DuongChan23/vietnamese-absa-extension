"""Machine-local, benchmark-validated inference settings (no model dependencies)."""

import json
import os
from pathlib import Path

PROFILE_PATH = Path(__file__).resolve().parents[1] / 'logs' / 'inference_runtime.json'


class InputTooLongError(ValueError):
    """The text does not fit the trained model's token window."""


def batch_size(value):
    size = int(value)
    if not 1 <= size <= 32:
        raise ValueError('ABSA_ENCODER_BATCH_SIZE must be 1..32')
    return size


def load_batch_size(signature, path=PROFILE_PATH):
    override = os.getenv('ABSA_ENCODER_BATCH_SIZE')
    if override is not None:
        return batch_size(override), 'environment'
    try:
        profile = json.loads(path.read_text(encoding='utf-8'))
        if profile['signature'] == signature and profile['outputs_equal'] is True:
            return batch_size(profile['encoder_batch_size']), 'validated_profile'
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return 1, 'serial_default'


def save_profile(signature, size, report_path, path=PROFILE_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps({
        'signature': signature,
        'encoder_batch_size': batch_size(size),
        'outputs_equal': True,
        'benchmark_report': str(report_path.resolve()),
    }, indent=2), encoding='utf-8')
    temporary.replace(path)
