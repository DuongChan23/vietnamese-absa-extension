import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReviewBatch } from '../extension/services/batch_service.js';
import { flushActivityLog } from '../extension/services/activity_service.js';

test('batch requests include run/product IDs, selected source and progress', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const logs = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/health')) return {
      ok: true, json: async () => ({ activity_log: { enabled: true, batch_endpoint: '/activity/log/batch' } })
    };
    const body = JSON.parse(options.body);
    if (url.endsWith('/activity/log/batch')) {
      logs.push(...body.events);
      return { ok: true };
    }
    requests.push(body);
    return { ok: true, json: async () => ({ results: body.reviews.map(row => ({ ...row, status: 'ok', aspects: [] })) }) };
  };
  try {
    const reviews = Array.from({ length: 21 }, (_, i) => ({ text: 'review ' + i, review_id: String(i), rating: 4 }));
    const progress = [];
    const result = await analyzeReviewBatch(
      reviews, '1.10', p => progress.push(p.processed),
      { runId: 'run-1', source: 'vicloabsa' }
    );
    assert.deepEqual(requests.map(body => body.reviews.length), [10, 10, 1]);
    assert.equal(requests[0].run_id, 'run-1');
    assert.equal(requests[0].source, 'vicloabsa');
    assert.equal(requests[0].product_id, '1.10');
    assert.deepEqual(progress, [10, 20, 21]);
    assert.equal(result.completed, 21);
    assert.equal(result.source, 'vicloabsa');
    await flushActivityLog();
    assert.equal(logs.filter(row => row.event === 'analysis_batch_completed').length, 3);
  } finally {
    await flushActivityLog();
    globalThis.fetch = originalFetch;
  }
});

test('batch result preserves backend provenance and preprocessing for JSON export', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('/predict/batch')
    ? {
      ok: true,
      json: async () => ({
        source: 'vicloabsa',
        model: 'NB39+NB46+NB04',
        evaluation_note: 'Source-conditioned inference as in NB55',
        category_merge_policy: 'source_preserving_exact_duplicate_v1',
        preprocessing: { accepted: 1, rejected: 0 },
        rejected: [],
        results: [{ review_id: 'r-1', text: 'áo đẹp', status: 'ok',
          aspects: [], aspects_merged: [] }],
      }),
    }
    : { ok: true, json: async () => ({ activity_log: { enabled: false } }) };
  try {
    const result = await analyzeReviewBatch(
      [{ review_id: 'r-1', text: 'áo đẹp' }], '1.10', () => {},
      { source: 'vicloabsa' }
    );
    assert.equal(result.model, 'NB39+NB46+NB04');
    assert.equal(result.evaluation_note, 'Source-conditioned inference as in NB55');
    assert.equal(result.category_merge_policy, 'source_preserving_exact_duplicate_v1');
    assert.deepEqual(result.preprocessing_batches, [
      { batch: 1, stats: { accepted: 1, rejected: 0 } },
    ]);
  } finally {
    await flushActivityLog();
    globalThis.fetch = originalFetch;
  }
});

test('phone/electronics selection is forwarded as visd4sa', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/health')) return {
      ok: true, json: async () => ({ activity_log: { enabled: false } })
    };
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        results: requests.at(-1).reviews.map(row => ({ ...row, status: 'ok', aspects: [] }))
      })
    };
  };
  try {
    const result = await analyzeReviewBatch(
      [{ text: 'Pin tốt', review_id: 'phone-1' }],
      'phone-product',
      () => {},
      { source: 'visd4sa' }
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].source, 'visd4sa');
    assert.equal(result.source, 'visd4sa');
  } finally {
    await flushActivityLog();
    globalThis.fetch = originalFetch;
  }
});

test('unsupported unified mode is rejected before sending a request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, json: async () => ({ results: [] }) };
  };
  try {
    await assert.rejects(
      analyzeReviewBatch([{ text: 'tốt' }], '1.10', () => {}, { source: 'unified' }),
      /Hãy chọn lĩnh vực/
    );
    assert.equal(requests, 0);
  } finally {
    await flushActivityLog();
    globalThis.fetch = originalFetch;
  }
});

test('aborting a product run prevents later batches', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/activity/log')) return { ok: true };
    if (url.endsWith('/health')) return {
      ok: true, json: async () => ({ activity_log: { enabled: true, batch_endpoint: '/activity/log/batch' } })
    };
    requests++;
    const body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ results: body.reviews.map(row => ({ ...row, status: 'ok' })) }) };
  };
  try {
    await assert.rejects(analyzeReviewBatch(
      Array.from({ length: 25 }, () => ({ text: 'tốt' })),
      '1.10',
      () => controller.abort(),
      { signal: controller.signal, runId: 'run-old' }
    ), { name: 'AbortError' });
    assert.equal(requests, 1);
  } finally {
    await flushActivityLog();
    globalThis.fetch = originalFetch;
  }
});

test('malformed batch responses stop without accepting fabricated results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => url.endsWith('/predict/batch')
    ? { ok: true, json: async () => ({ results: [null] }) }
    : { ok: true, json: async () => ({ activity_log: { enabled: true } }) };
  try {
    const result = await analyzeReviewBatch([{ text: 'tốt' }], '1.10');
    assert.equal(result.stopped_early, true);
    assert.equal(result.completed, 0);
    assert.match(result.error, /không trả về danh sách/);
  } finally {
    await flushActivityLog();
    globalThis.fetch = originalFetch;
  }
});
