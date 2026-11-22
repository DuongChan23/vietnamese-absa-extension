import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReviewBatch } from '../extension/services/batch_service.js';
import { flushActivityLog } from '../extension/services/activity_service.js';

test('batch requests include run/product IDs and log progress without changing reviews', async () => {
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
    const reviews = Array.from({ length: 21 }, (_, i) => ({ text: `review ${i}`, review_id: String(i), rating: 4 }));
    const progress = [];
    const result = await analyzeReviewBatch(reviews, '1.10', p => progress.push(p.processed), { runId: 'run-1' });
    assert.deepEqual(requests.map(body => body.reviews.length), [10, 10, 1]);
    assert.equal(requests[0].run_id, 'run-1');
    assert.equal(requests[0].product_id, '1.10');
    assert.deepEqual(progress, [10, 20, 21]);
    assert.equal(result.completed, 21);
    await flushActivityLog();
    assert.equal(logs.filter(row => row.event === 'analysis_batch_completed').length, 3);
  } finally { await flushActivityLog(); globalThis.fetch = originalFetch; }
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
      Array.from({ length: 25 }, () => ({ text: 'tốt' })), '1.10',
      () => controller.abort(), { signal: controller.signal, runId: 'run-old' }
    ), { name: 'AbortError' });
    assert.equal(requests, 1);
  } finally { await flushActivityLog(); globalThis.fetch = originalFetch; }
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
  } finally { await flushActivityLog(); globalThis.fetch = originalFetch; }
});
