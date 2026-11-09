"""Compare original and reused inference outputs and elapsed time on real models.

Run from the project root:
    python -m backend.benchmark_inference reviews.json --limit 10 --repeats 2

Input: JSON list (strings or review objects), an object with a `reviews` list,
or an extension-exported CSV with a `text` column. No review text is printed.
"""

import argparse
import csv
import json
from pathlib import Path
from time import perf_counter

from .category_normalizer import merge_aspects
from .inference_reuse import ExactPredictionCache
from .preprocessing import prepare_reviews


def load_texts(path, limit):
    if path.suffix.lower() == '.csv':
        with path.open(encoding='utf-8-sig', newline='') as file:
            # Ratings and IDs do not affect model input. CSV ratings are strings.
            items = [row.get('text', '') for row in csv.DictReader(file)]
    else:
        payload = json.loads(path.read_text(encoding='utf-8-sig'))
        items = payload.get('reviews') if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise ValueError('JSON must be a list or contain a reviews list')
    prepared = prepare_reviews(items)
    texts = [row['text'] for row in prepared['reviews'] if len(row['text']) <= 3000]
    return texts[:limit]


def run_once(model, texts, source, reuse):
    def predict(text, selected_source):
        if selected_source == 'unified':
            return model.predict_unified(text, reuse_sentiments=reuse)
        return model.predict(text, selected_source)

    # Match the API's cache scope (one request, at most 30 accepted reviews).
    cache = ExactPredictionCache(predict) if reuse else None
    results = []
    for text in texts:
        raw = cache.predict(text, source) if reuse else predict(text, source)
        results.append({'aspects': raw, 'aspects_merged': merge_aspects(raw)})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reviews', type=Path)
    parser.add_argument('--source', default='unified')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--repeats', type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.limit <= 30 or args.repeats < 1:
        parser.error('--limit must be 1..30 and --repeats must be positive')
    texts = load_texts(args.reviews, args.limit)
    if not texts:
        parser.error('No valid reviews to compare')

    # Keep --help/input validation usable without installing ML dependencies.
    import torch
    from .inference import ABSAPredictor, DEVICE
    model = ABSAPredictor()
    if args.source != 'unified' and args.source not in model.categories:
        parser.error(f'Unknown source: {args.source}')

    def synchronize():
        if DEVICE.type == 'cuda':
            torch.cuda.synchronize(DEVICE)

    # Warm up both paths; checkpoint loading is excluded from timings.
    warm_reference = run_once(model, texts[:1], args.source, False)
    warm_optimized = run_once(model, texts[:1], args.source, True)
    mismatches = []
    if warm_reference != warm_optimized:
        mismatches.append({'repeat': 'warmup', 'review_indices': [0]})
    times = {'reference': [], 'optimized': []}
    for repeat in range(args.repeats):
        outputs = {}
        # Alternate order to reduce systematic warmup/thermal timing bias.
        modes = [('reference', False), ('optimized', True)]
        if repeat % 2:
            modes.reverse()
        for name, reuse in modes:
            synchronize()
            start = perf_counter()
            outputs[name] = run_once(model, texts, args.source, reuse)
            synchronize()
            times[name].append(perf_counter() - start)
        changed = [i for i, (old, new) in enumerate(zip(
            outputs['reference'], outputs['optimized']
        )) if old != new]
        if changed:
            mismatches.append({'repeat': repeat + 1, 'review_indices': changed})
    old_time = sum(times['reference']) / args.repeats
    new_time = sum(times['optimized']) / args.repeats
    print(json.dumps({
        'device': str(DEVICE),
        'source': args.source,
        'reviews': len(texts),
        'unique_texts': len(set(texts)),
        'outputs_equal': not mismatches,
        'mismatches': mismatches,
        'seconds': times,
        'mean_seconds': {'reference': old_time, 'optimized': new_time},
        'speedup': old_time / new_time if new_time else None,
    }, indent=2))
    return 1 if mismatches else 0


if __name__ == '__main__':
    raise SystemExit(main())
