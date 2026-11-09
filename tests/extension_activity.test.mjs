import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityClient } from '../extension/services/activity_service.js';

function memoryStorage() {
  let values = {};
  return {
    get: async () => structuredClone(values),
    set: async next => { values = structuredClone({ ...values, ...next }); },
  };
}
const payload = index => ({
  event: 'collection_page', run_id: 'run-1', product_id: '1.10',
  client_time: '2026-11-09T10:00:00Z', duration_ms: index * 1000, details: { page: index }
});

test('an old backend is detected without repeatedly posting to a missing logging route', async () => {
  const calls = [];
  const storage = memoryStorage();
  const client = createActivityClient({ storage, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/health') ? { ready: true } : { paths: {} } };
  } });
  for (let i = 1; i <= 12; i++) await client.record(payload(i));
  const state = await client.flush();
  assert.equal(state.mode, 'backend_update_required');
  assert.equal(state.pending, 12);
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 0);
  assert.equal(calls.filter(call => call.url.endsWith('/health')).length, 1);
  assert.equal((await storage.get()).absaPendingActivity.length, 12);
});

test('queued logs survive a worker restart and flush when the updated backend appears', async () => {
  const storage = memoryStorage();
  const oldClient = createActivityClient({ storage, fetchImpl: async url => ({
    ok: true, json: async () => url.endsWith('/health') ? { ready: true } : { paths: {} }
  }) });
  await oldClient.record(payload(1));
  await oldClient.record(payload(2));
  await oldClient.flush();
  const written = [];
  const newClient = createActivityClient({ storage, fetchImpl: async (url, options) => {
    if (url.endsWith('/health')) return {
      ok: true, json: async () => ({ activity_log: { enabled: true, batch_endpoint: '/activity/log/batch' } })
    };
    assert.equal(url.endsWith('/activity/log/batch'), true);
    written.push(...JSON.parse(options.body).events);
    return { ok: true };
  } });
  const state = await newClient.flush(true);
  assert.equal(state.mode, 'available');
  assert.equal(state.pending, 0);
  assert.deepEqual(written.map(event => event.details.page), [1, 2]);
  assert.equal(written[0].client_time, payload(1).client_time);
  assert.equal((await storage.get()).absaPendingActivity.length, 0);
});

test('a stale advertised route returning 404 is tried only once during the retry interval', async () => {
  let posts = 0;
  const client = createActivityClient({ fetchImpl: async (url, options) => {
    if (options.method === 'POST') { posts++; return { ok: false, status: 404 }; }
    return { ok: true, json: async () => ({ activity_log: { enabled: true } }) };
  } });
  await client.record(payload(1));
  await client.flush();
  await client.record(payload(2));
  const state = await client.flush();
  assert.equal(posts, 1);
  assert.equal(state.pending, 2);
});

test('concurrent writers keep every event while requests drain the shared queue', async () => {
  const delivered = [];
  const client = createActivityClient({ storage: memoryStorage(), fetchImpl: async (url, options) => {
    if (url.endsWith('/health')) return {
      ok: true, json: async () => ({ activity_log: { enabled: true, batch_endpoint: '/activity/log/batch' } })
    };
    const group = JSON.parse(options.body).events;
    assert.ok(group.length <= 50);
    delivered.push(...group);
    return { ok: true };
  } });
  await Promise.all(Array.from({ length: 120 }, (_, i) => client.record(payload(i))));
  await client.flush();
  assert.equal(client.status().pending, 0);
  assert.equal(new Set(delivered.map(event => event.event_id)).size, 120);
  assert.equal(delivered.length, 120);
});

test('a bounded offline queue retains the most recent events', async () => {
  const client = createActivityClient({ maxPending: 3, fetchImpl: async () => { throw new Error('offline'); } });
  for (let i = 0; i < 5; i++) await client.record(payload(i));
  const state = await client.flush();
  assert.equal(state.mode, 'backend_unavailable');
  assert.equal(state.pending, 3);
  assert.equal(state.dropped, 2);
});
