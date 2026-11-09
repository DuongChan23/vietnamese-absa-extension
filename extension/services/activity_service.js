"use strict";

const API_URL = "http://127.0.0.1:8000";

export function createActivityClient({
  fetchImpl = (...args) => fetch(...args),
  storage = globalThis.chrome?.storage?.local,
  now = () => Date.now(), retryMs = 30000, maxPending = 5000,
  onStatus = () => {}
} = {}) {
  const storageKey = 'absaPendingActivity';
  let pending = [];
  let loaded;
  let mutations = Promise.resolve();
  let flushing = null;
  let capability = null;
  let nextProbe = 0;
  let mode = 'unknown';
  let dropped = 0;
  const status = () => ({ mode, pending: pending.length, dropped });
  const publish = value => {
    const changed = mode !== value;
    mode = value;
    if (changed) onStatus(status());
  };
  const load = () => loaded ||= (async () => {
    const saved = storage ? (await storage.get(storageKey))[storageKey] : [];
    if (Array.isArray(saved)) pending = saved.slice(-maxPending);
  })();
  const mutate = action => {
    const operation = mutations.then(async () => {
      await load();
      action();
      if (storage) await storage.set({ [storageKey]: pending });
    });
    mutations = operation.catch(() => {});
    return operation;
  };
  async function discover(force) {
    if (!force && now() < nextProbe) return capability;
    try {
      const response = await fetchImpl(`${API_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('backend_unavailable');
      const health = await response.json();
      let supported = health.activity_log?.enabled === true;
      let batch = supported && health.activity_log?.batch_endpoint === '/activity/log/batch';
      if (!supported) {
        // Older health responses did not advertise logging. Inspect routes
        // before posting so an old API does not produce a 404 for every event.
        const schema = await fetchImpl(`${API_URL}/openapi.json`, { signal: AbortSignal.timeout(3000) });
        const paths = schema.ok ? (await schema.json()).paths : {};
        supported = Boolean(paths?.['/activity/log']?.post);
        batch = Boolean(paths?.['/activity/log/batch']?.post);
      }
      capability = supported ? { batch } : null;
      nextProbe = now() + retryMs;
      publish(supported ? 'available' : 'backend_update_required');
    } catch {
      capability = null;
      nextProbe = now() + retryMs;
      publish('backend_unavailable');
    }
    return capability;
  }
  async function flush(force = false) {
    if (flushing) return flushing;
    flushing = (async () => {
      await load();
      await mutations;
      const supported = await discover(force);
      if (!supported) return status();
      while (pending.length) {
        const group = pending.slice(0, supported.batch ? 50 : 1);
        try {
          const response = await fetchImpl(`${API_URL}/activity/log${supported.batch ? '/batch' : ''}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(supported.batch ? { events: group } : group[0]),
            signal: AbortSignal.timeout(5000)
          });
          if (!response.ok) {
            capability = null;
            nextProbe = now() + retryMs;
            publish([404, 405].includes(response.status) ? 'backend_update_required' : 'backend_unavailable');
            return status();
          }
          const sent = new Set(group.map(entry => entry.event_id));
          await mutate(() => { pending = pending.filter(entry => !sent.has(entry.event_id)); });
        } catch {
          capability = null;
          nextProbe = now() + retryMs;
          publish('backend_unavailable');
          return status();
        }
      }
      publish('available');
      return status();
    })().catch(() => {
      publish('storage_unavailable');
      return status();
    }).finally(() => { flushing = null; });
    return flushing;
  }
  async function record(payload) {
    try {
      await mutate(() => {
        pending.push({ ...payload, event_id: payload.event_id || crypto.randomUUID() });
        if (pending.length > maxPending) {
          dropped += pending.length - maxPending;
          pending.splice(0, pending.length - maxPending);
        }
      });
      void flush();
      return { ok: true, queued: true, status: status() };
    } catch {
      publish('storage_unavailable');
      return { ok: false, status: status() };
    }
  }
  return { record, flush, status };
}

const client = createActivityClient({ onStatus: status => {
  const runtime = globalThis.chrome?.runtime;
  if (runtime?.sendMessage) void runtime.sendMessage({ type: 'ABSA_LOG_STATUS', status }).catch(() => {});
} });

// Only the background worker owns persistent queue writes. Panels and injected
// collectors send it short messages, avoiding lost updates between contexts.
export const recordActivity = payload => client.record(payload);
export const flushActivityLog = (force = false) => client.flush(force);

export async function logActivity(event, context = {}, details = {}, durationMs = null) {
  const payload = {
    event, run_id: context.runId ?? null, product_id: context.productId ?? null,
    client_time: new Date().toISOString(), duration_ms: durationMs, details
  };
  try {
    const runtime = globalThis.chrome?.runtime;
    const result = runtime?.sendMessage
      ? await runtime.sendMessage({ type: 'ABSA_LOG_ACTIVITY', payload })
      : await recordActivity(payload);
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}
