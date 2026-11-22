"""Compare serial and FP32 encoder batching on real checkpoints.

Run from the project root:
    python -m backend.benchmark_inference reviews.json --limit 10 --repeats 2

Input: JSON list (strings or review objects), an object with a `reviews` list,
or an extension-exported CSV with a `text` column. No review text is printed.
"""

import argparse
import csv
import hashlib
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


def run_once(model, texts, source, reuse, encoder_batch_size=None):
    def predict(text, selected_source):
        options = {'encoder_batch_size': encoder_batch_size} if encoder_batch_size is not None else {}
        if selected_source == 'unified':
            return model.predict_unified(text, reuse_sentiments=reuse, **options)
        return model.predict(text, selected_source, **options)

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
    parser.add_argument('--batch-sizes', type=int, nargs='+', default=[1, 4, 8, 16])
    parser.add_argument('--output', type=Path, default=Path('logs/inference_benchmark.json'))
    parser.add_argument('--activate', action='store_true',
                        help='Save fastest matching configuration for this machine/checkpoints')
    args = parser.parse_args()
    # VnCoreNLP changes the process working directory during initialization.
    args.reviews = args.reviews.resolve()
    args.output = args.output.resolve()
    if not 1 <= args.limit <= 30 or args.repeats < 1:
        parser.error('--limit must be 1..30 and --repeats must be positive')
    if any(not 1 <= size <= 32 for size in args.batch_sizes):
        parser.error('--batch-sizes must be 1..32')
    if args.activate and (args.source != 'unified' or args.repeats < 2):
        parser.error('--activate requires --source unified and --repeats >= 2')
    sizes = list(dict.fromkeys([1, *args.batch_sizes]))
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

    # Both paths retain the existing exact-text/span reuse. Measure batching's
    # additional benefit, excluding checkpoint load and warmup.
    warm_reference = run_once(model, texts[:1], args.source, True, 1)
    mismatches = {size: [] for size in sizes}
    for size in sizes[1:]:
        if run_once(model, texts[:1], args.source, True, size) != warm_reference:
            mismatches[size].append({'repeat': 'warmup', 'review_indices': [0]})
    times = {size: [] for size in sizes}
    for repeat in range(args.repeats):
        outputs = {}
        # Alternate order to reduce systematic warmup/thermal timing bias.
        modes = sizes[:]
        if repeat % 2:
            modes.reverse()
        for size in modes:
            synchronize()
            start = perf_counter()
            outputs[size] = run_once(model, texts, args.source, True, size)
            synchronize()
            times[size].append(perf_counter() - start)
            print(f'repeat={repeat+1} batch_size={size} seconds={times[size][-1]:.3f}', flush=True)
        for size in sizes[1:]:
            changed = [i for i, (old, new) in enumerate(zip(outputs[1], outputs[size])) if old != new]
            if changed:
                mismatches[size].append({'repeat': repeat + 1, 'review_indices': changed})
    means = {size: sum(values)/args.repeats for size, values in times.items()}
    eligible = [size for size in sizes if not mismatches[size]]
    fastest = min(eligible, key=means.get)
    # Avoid enabling batching for timing noise alone.
    selected = fastest if means[1]/means[fastest] >= 1.05 else 1
    report = {
        'runtime': model.runtime_info(),
        'signature': model.runtime_signature,
        'input_sha256': hashlib.sha256(args.reviews.read_bytes()).hexdigest(),
        'source': args.source,
        'reviews': len(texts),
        'unique_texts': len(set(texts)),
        'outputs_equal': all(not differences for differences in mismatches.values()),
        'mismatches': mismatches,
        'seconds': times,
        'mean_seconds': means,
        'speedup': {size: means[1]/duration if duration else None for size, duration in means.items()},
        'selected_batch_size': selected,
        'activated': args.activate,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), encoding='utf-8')
    if args.activate:
        from .inference_runtime import save_profile
        save_profile(model.runtime_signature, selected, args.output)
    print(json.dumps(report, indent=2))
    return 0 if report['outputs_equal'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
