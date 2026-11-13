import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { ProductSession, productIdFromUrl } from '../extension/services/product_context.js';
import { buildAnalytics } from '../extension/services/analytics_service.js';
import { API_URL } from '../extension/services/api_config.js';

// Inject the real imported dependencies into a small DOM/Chrome harness.
const source = (await fs.readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '');
const batchSource = (await fs.readFile(new URL('../extension/services/batch_service.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

function panelFixture({ metadata, predictBatch, collectReviews } = {}) {
  const elements = new Map();
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  function element() {
    const classes = new Set();
    return {
      textContent: '', value: '', hidden: false, disabled: false, dataset: {}, style: {},
      children: [], childNodes: [], listeners: {},
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name),
      },
      setAttribute() {},
      replaceChildren(...children) { this.children = children; this.childNodes = children; },
      append(...children) { this.children.push(...children); this.childNodes = this.children; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
    };
  }
  const choices = ['50', '100', '200', 'all'].map(limit => ({ ...element(), dataset: { limit } }));
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const tab = { id: 1, url: 'https://shopee.vn/a-i.1.10' };
  const tabs = {
    query: async () => [{ ...tab }], get: async () => ({ ...tab }),
    onActivated: event(), onUpdated: event(),
  };
  const messages = [];
  const batchRequests = [];
  const chrome = {
    tabs, windows: { onFocusChanged: event() },
    runtime: {
      onMessage: event(),
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'COLLECT_SHOPEE_PRODUCT') {
          return metadata ? metadata(message.productId) :
            { ok: true, product_id: message.productId, name: `Product ${message.productId}` };
        }
        if (message.type === 'COLLECT_SHOPEE_REVIEWS' && collectReviews) return collectReviews(message);
        return { ok: true };
      }
    }
  };
  const context = vm.createContext({
    ProductSession, productIdFromUrl, buildAnalytics, API_URL, logActivity: async () => true,
    document: { querySelector: get, querySelectorAll: () => choices, createElement: element },
    chrome, URL, crypto, AbortController, AbortSignal, DOMException, performance, console,
    setInterval() {}, setTimeout: fn => queueMicrotask(fn),
    fetch: async (url, options) => {
      if (url.endsWith('/predict/batch')) {
        const payload = JSON.parse(options.body);
        batchRequests.push({ payload, signal: options.signal });
        if (predictBatch) return predictBatch(payload, options.signal);
        return { ok: true, json: async () => ({ results: payload.reviews.map(row => ({
          ...row, status: 'ok', aspects: [], aspects_merged: [],
        })) }) };
      }
      return { ok: true, json: async () => ({ ready: true }) };
    },
  });
  context.analyzeReviewBatch = vm.runInContext(`(() => { ${batchSource}; return analyzeReviewBatch; })()`, context);
  vm.runInContext(source, context);
  return {
    context, get, tab, tabs, messages, batchRequests,
    evaluate: code => vm.runInContext(code, context),
    navigate(url) { tab.url = url; tabs.onUpdated.listeners[0](tab.id, { url }); },
    deliver(message) { chrome.runtime.onMessage.listeners.forEach(fn => fn(message)); },
  };
}

test('the panel automatically loads the current product and clears old results on navigation', async () => {
  const panel = panelFixture();
  await flush();
  assert.equal(panel.get('#productName').textContent, 'Product 1.10');
  panel.evaluate('collectedReviews = [{text:"old"}]; latestBatchResult = {results:[{}]};');
  panel.get('#dashboard').hidden = false;
  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  assert.equal(panel.get('#productName').textContent, 'Product 1.20');
  assert.equal(panel.get('#dashboard').hidden, true);
  assert.equal(panel.evaluate('collectedReviews.length'), 0);
  assert.equal(panel.evaluate('latestBatchResult'), null);
});

test('metadata arriving late from the old product cannot overwrite the new product', async () => {
  let resolveOld;
  const panel = panelFixture({ metadata: id => id === '1.10' ?
    new Promise(resolve => { resolveOld = resolve; }) :
    { ok: true, product_id: id, name: `Product ${id}` }
  });
  await flush();
  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  resolveOld({ ok: true, product_id: '1.10', name: 'OLD PRODUCT' });
  await flush();
  assert.equal(panel.get('#productName').textContent, 'Product 1.20');
  assert.equal(panel.evaluate('currentProductId'), '1.20');
});

test('changing products while collecting ends the pending run and ignores late reviews', async () => {
  let collectorRequest;
  const panel = panelFixture({ collectReviews: message => {
    collectorRequest = message;
    return { ok: true, started: true, run_id: message.runId };
  } });
  await flush();
  const pending = panel.get('#runAnalysis').listeners.click();
  await flush();
  assert.equal(panel.evaluate('pendingCollections.size'), 1);
  assert.equal(panel.get('#productSwitch').hidden, true);
  panel.navigate('https://shopee.vn/b-i.1.20');
  await pending;
  await flush();
  panel.deliver({
    type: 'ABSA_COLLECTION_DONE', run_id: collectorRequest.runId, product_id: '1.10',
    data: { ok: true, product_id: '1.10', reviews: [{ text: 'OLD REVIEW' }] },
  });
  assert.equal(panel.evaluate('collectedReviews.length'), 0);
  assert.equal(panel.evaluate('pendingCollections.size'), 0);
  assert.equal(panel.get('#productName').textContent, 'Product 1.20');
  assert.equal(panel.get('#runAnalysis').disabled, false);
  assert.equal(panel.get('#productSwitch').hidden, true);
});

test('star-only products show native Shopee ratings without sending text to the model', async () => {
  let modelRequests = 0;
  const panel = panelFixture({
    metadata: id => ({ ok: true, product_id: id, name: 'Product', rating: 4.8, review_count: 100 }),
    predictBatch: () => { modelRequests++; throw new Error('must not infer without comments'); },
    collectReviews: () => ({ ok: true, product_id: '1.10', reviews: [],
      rating_summary: { source: 'shopee', counts: { 1: 0, 2: 0, 3: 0, 4: 20, 5: 80 }, total: 100 },
      stats: { stop_reason: 'end_of_reviews', pages_checked: 3 }
    }),
  });
  await flush();
  await panel.get('#runAnalysis').listeners.click();
  assert.equal(modelRequests, 0);
  assert.equal(panel.get('#averageRating').textContent, '4.80');
  assert.equal(panel.get('#ratingSample').textContent, '100 đánh giá');
  assert.equal(panel.get('#dashboard').hidden, false);
  assert.equal(panel.evaluate('latestAnalytics.collected'), 0);
  assert.match(panel.get('#status').textContent, /Chưa lấy được bình luận có nội dung/);
  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  assert.equal(panel.get('#dashboard').hidden, true);
});

function collectedProduct(count = 21) {
  return {
    ok: true, product_id: '1.10',
    reviews: Array.from({ length: count }, (_, i) => ({
      review_id: `review-${i}`, text: `Bình luận ${i}`, rating: 5,
    })),
    stats: { stop_reason: 'target_reached', pages_checked: 4 },
  };
}

function modelResponse(payload) {
  return { ok: true, json: async () => ({ results: payload.reviews.map(row => ({
    ...row, status: 'ok', aspects_merged: [{
      start: 0, end: 4, aspect: row.text.slice(0, 4), category: 'General', sentiment: 'positive',
    }],
  })) }) };
}

test('all analysis batches finish for the collected product while navigation and late collection messages are ignored', async () => {
  let resolveFirst;
  let firstPayload;
  const panel = panelFixture({
    collectReviews: () => collectedProduct(),
    predictBatch: payload => {
      if (firstPayload) return modelResponse(payload);
      firstPayload = payload;
      return new Promise(resolve => { resolveFirst = resolve; });
    },
  });
  await flush();
  const pending = panel.get('#runAnalysis').listeners.click();
  await flush();
  const run = panel.evaluate('session.run');
  assert.equal(run.stage, 'analyzing');
  assert.equal(panel.get('#productSwitch').hidden, true);

  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  panel.navigate('https://shopee.vn/c-i.1.30');
  await flush();
  assert.equal(run.signal.aborted, false);
  assert.equal(panel.get('#productName').textContent, 'Product 1.10');
  assert.equal(panel.get('#productSwitch').hidden, false);
  assert.equal(panel.messages.some(message => message.type === 'COLLECT_SHOPEE_PRODUCT' &&
    message.productId !== '1.10'), false);
  const progress = panel.get('#progressText').textContent;
  panel.deliver({ type: 'ABSA_COLLECTION_PROGRESS', run_id: run.runId, product_id: run.productId,
    stats: { collected: 999, page: 99 } });
  assert.equal(panel.get('#progressText').textContent, progress);

  resolveFirst(modelResponse(firstPayload));
  await pending;
  assert.deepEqual(panel.batchRequests.map(request => request.payload.reviews.length), [10, 10, 1]);
  assert.ok(panel.batchRequests.every(request => request.payload.product_id === '1.10' &&
    request.payload.run_id === run.runId && !request.signal.aborted));
  assert.equal(panel.get('#dashboard').hidden, false);
  assert.equal(panel.evaluate('latestBatchResult.completed'), 21);
  assert.equal(panel.evaluate('currentProductId'), '1.10');
  assert.equal(panel.get('#runAnalysis').disabled, true);
  assert.equal(panel.get('#switchProduct').disabled, false);
  assert.match(panel.get('#status').textContent, /Hoàn tất/);

  const results = panel.evaluate('latestBatchResult');
  panel.navigate('https://shopee.vn/a-i.1.10?extra=2');
  await flush();
  assert.equal(panel.get('#productSwitch').hidden, true);
  assert.equal(panel.get('#runAnalysis').disabled, false);
  panel.navigate('https://example.com');
  await flush();
  assert.equal(panel.get('#productSwitch').hidden, true);
  assert.equal(panel.evaluate('latestBatchResult'), results);
  assert.equal(panel.get('#dashboard').hidden, false);

  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  // Clicking the normal analysis action cannot silently replace pinned data.
  await panel.get('#runAnalysis').listeners.click();
  assert.equal(panel.evaluate('latestBatchResult'), results);
  // Resolve the target again on click: a pending URL update must not select B.
  panel.tab.url = 'https://shopee.vn/c-i.1.30';
  await panel.get('#switchProduct').listeners.click();
  assert.equal(panel.get('#productName').textContent, 'Product 1.30');
  assert.equal(panel.get('#dashboard').hidden, true);
  assert.equal(panel.evaluate('latestBatchResult'), null);
  assert.equal(panel.evaluate('collectedReviews.length'), 0);
  assert.equal(panel.get('#productSwitch').hidden, true);
  assert.equal(panel.get('#runAnalysis').disabled, false);
});

test('explicitly switching during analysis aborts old work and prevents late results or further batches', async () => {
  let resolveResponse;
  let payload;
  const panel = panelFixture({
    collectReviews: () => collectedProduct(),
    predictBatch: body => {
      payload = body;
      return new Promise(resolve => { resolveResponse = resolve; });
    },
  });
  await flush();
  const pending = panel.get('#runAnalysis').listeners.click();
  await flush();
  const oldRun = panel.evaluate('session.run');
  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  assert.equal(oldRun.signal.aborted, false);
  await panel.get('#switchProduct').listeners.click();
  assert.equal(oldRun.signal.aborted, true);
  assert.equal(panel.get('#productName').textContent, 'Product 1.20');
  resolveResponse(modelResponse(payload));
  await pending;
  assert.equal(panel.batchRequests.length, 1);
  assert.equal(panel.evaluate('latestBatchResult'), null);
  assert.equal(panel.evaluate('collectedReviews.length'), 0);
  assert.equal(panel.get('#dashboard').hidden, true);
  assert.equal(panel.get('#runAnalysis').disabled, false);
  assert.doesNotMatch(panel.get('#status').textContent, /Hoàn tất/);
});

test('stopping or failing analysis keeps the collected product until an explicit switch', async t => {
  for (const mode of ['cancel', 'failure']) {
    await t.test(mode, async () => {
      let resolveResponse;
      const panel = panelFixture({
        collectReviews: () => collectedProduct(1),
        predictBatch: () => new Promise(resolve => { resolveResponse = resolve; }),
      });
      await flush();
      const pending = panel.get('#runAnalysis').listeners.click();
      await flush();
      panel.navigate('https://shopee.vn/b-i.1.20');
      await flush();
      if (mode === 'cancel') panel.get('#cancelAnalysis').listeners.click();
      resolveResponse({ ok: false, status: 503, text: async () => 'model unavailable' });
      await pending;
      assert.equal(panel.get('#productName').textContent, 'Product 1.10');
      assert.equal(panel.get('#productSwitch').hidden, false);
      if (mode === 'failure') {
        assert.equal(panel.get('#progressText').textContent, 'Đã dừng phân tích');
      }
      assert.equal(panel.evaluate('session.run'), null);
      assert.equal(panel.evaluate('session.pinned'), true);
      panel.navigate('https://shopee.vn/c-i.1.30');
      await flush();
      assert.equal(panel.get('#productName').textContent, 'Product 1.10');
      await panel.get('#switchProduct').listeners.click();
      assert.equal(panel.get('#productName').textContent, 'Product 1.30');
    });
  }
});

test('identical text with a rejected review cannot shift a different review result', async () => {
  const panel = panelFixture();
  await flush();
  panel.evaluate(`
    collectedReviews = [
      {review_id: 'rejected', text: 'giống nhau', rating: 6},
      {review_id: 'valid', text: 'giống nhau', rating: 5}
    ];
    latestBatchResult = {results: [{review_id: 'valid', text: 'giống nhau', status: 'ok',
      aspects_merged: [{category: 'General', sentiment: 'positive'}]}]};
    renderReviews();
  `);
  const cards = panel.get('#reviewList').children;
  assert.equal(cards[0].children.some(child => child.className === 'tags'), false);
  assert.equal(cards[1].children.find(child => child.className === 'tags').children.length, 1);
  assert.match(cards[0].children.at(-1).textContent, /chưa có kết quả/);
  panel.evaluate(`selectedRating = '5'; renderReviews();`);
  assert.equal(panel.get('#reviewList').children[0].children.find(child => child.className === 'tags').children.length, 1);
});
