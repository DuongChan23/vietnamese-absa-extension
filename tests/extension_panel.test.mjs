import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { ProductSession, productIdFromUrl } from '../extension/services/product_context.js';
import { buildAnalytics } from '../extension/services/analytics_service.js';

// Inject the real imported dependencies into a small DOM/Chrome harness.
const source = (await fs.readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));

function panelFixture({ metadata, predict, collectReviews } = {}) {
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
  const chrome = {
    tabs, windows: { onFocusChanged: event() },
    scripting: { executeScript: async () => [{ result: '' }] },
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
    ProductSession, productIdFromUrl, buildAnalytics, logActivity: async () => true,
    document: { querySelector: get, querySelectorAll: () => choices, createElement: element },
    chrome, URL, crypto, AbortController, AbortSignal, DOMException, performance, console,
    setInterval() {}, setTimeout: fn => queueMicrotask(fn),
    fetch: async url => url.endsWith('/predict') && predict ? predict() :
      { ok: true, json: async () => ({ ready: true }) },
  });
  vm.runInContext(source, context);
  return {
    context, get, tab, tabs, messages,
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

test('a late manual-model response is ignored after changing products', async () => {
  let resolveResponse;
  const panel = panelFixture({ predict: () => new Promise(resolve => { resolveResponse = resolve; }) });
  await flush();
  panel.get('#review').value = 'Pin tốt';
  const pending = panel.get('#analyze').listeners.click();
  await flush();
  const oldRun = panel.evaluate('session.run');
  panel.navigate('https://shopee.vn/b-i.1.20');
  await flush();
  assert.equal(oldRun.signal.aborted, true);
  resolveResponse({ ok: true, json: async () => ({ aspects: [{ aspect: 'pin', sentiment: 'positive' }] }) });
  await pending;
  assert.equal(panel.get('#results').childNodes.length, 0);
  assert.equal(panel.get('#productName').textContent, 'Product 1.20');
  assert.equal(panel.get('#runAnalysis').disabled, false);
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
});

test('star-only products show native Shopee ratings without sending text to the model', async () => {
  let modelRequests = 0;
  const panel = panelFixture({
    metadata: id => ({ ok: true, product_id: id, name: 'Product', rating: 4.8, review_count: 100 }),
    predict: () => { modelRequests++; throw new Error('must not infer without comments'); },
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
