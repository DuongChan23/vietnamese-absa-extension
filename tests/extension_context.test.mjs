import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductSession, productIdFromUrl } from '../extension/services/product_context.js';

test('recognizes Shopee product routes and rejects other hosts', () => {
  assert.equal(productIdFromUrl('https://shopee.vn/Áo-i.123.456?extra=1'), '123.456');
  assert.equal(productIdFromUrl('https://shopee.vn/product/123/456'), '123.456');
  assert.equal(productIdFromUrl('https://shopee.vn/?shopid=123&itemid=456'), '123.456');
  assert.equal(productIdFromUrl('https://shopee.vn.evil.test/a-i.123.456'), null);
  assert.equal(productIdFromUrl('https://shopee.vn/search?keyword=áo'), null);
});

test('product changes abort the previous run and make late results stale', () => {
  const session = new ProductSession();
  session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10' });
  const old = session.begin();
  assert.equal(session.isCurrent(old), true);
  assert.equal(session.update({ id: 1, url: 'https://shopee.vn/b-i.1.20' }), true);
  assert.equal(old.signal.aborted, true);
  assert.equal(session.isCurrent(old), false);
  const next = session.begin();
  assert.equal(session.isCurrent(next), true);
  assert.equal(next.productId, '1.20');
});

test('query-only navigation preserves results; switching tabs resets them', () => {
  const session = new ProductSession();
  session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10' });
  const run = session.begin();
  assert.equal(session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10?extra=2' }), false);
  assert.equal(session.isCurrent(run), true);
  assert.equal(session.update({ id: 2, url: 'https://shopee.vn/a-i.1.10' }), true);
  assert.equal(run.signal.aborted, true);
});

test('a newer run and leaving Shopee invalidate earlier work', () => {
  const session = new ProductSession();
  session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10' });
  const old = session.begin();
  const newer = session.begin();
  assert.equal(session.isCurrent(old), false);
  assert.equal(session.isCurrent(newer), true);
  session.update({ id: 1, url: 'https://example.com' });
  assert.equal(newer.signal.aborted, true);
  assert.equal(session.context.productId, null);
});

test('analysis stays pinned through navigation and completion until an explicit product switch', () => {
  const session = new ProductSession();
  session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10' });
  const run = session.begin();
  assert.equal(session.pinForAnalysis(run), true);
  assert.equal(run.stage, 'analyzing');
  assert.equal(session.update({ id: 1, url: 'https://shopee.vn/b-i.1.20' }), false);
  assert.equal(session.context.productId, '1.10');
  assert.equal(session.pageContext.productId, '1.20');
  assert.equal(session.isCurrent(run), true);
  assert.equal(session.canSwitchProduct, true);
  assert.equal(session.finish(run), true);
  session.update({ id: 2, url: 'https://shopee.vn/c-i.1.30' });
  assert.equal(session.pinned, true);
  assert.equal(session.context.productId, '1.10');
  assert.throws(() => session.begin(), /product_switch_required/);
  assert.equal(session.update({ id: 2, url: 'https://shopee.vn/c-i.1.30' }, { switchProduct: true }), true);
  assert.equal(session.context.productId, '1.30');
  assert.equal(session.pinned, false);
  assert.equal(session.canSwitchProduct, false);
});

test('only a different Shopee product can expose or perform the explicit switch', () => {
  const session = new ProductSession();
  session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10' });
  const run = session.begin();
  session.pinForAnalysis(run);
  for (const url of ['https://shopee.vn/a-i.1.10?extra=2', 'https://shopee.vn/search', 'https://example.com']) {
    assert.equal(session.update({ id: 2, url }, { switchProduct: true }), false);
    assert.equal(session.canSwitchProduct, false);
    assert.equal(session.pinned, true);
    assert.equal(session.isCurrent(run), true);
  }
  session.cancel();
  session.update({ id: 3, url: 'https://shopee.vn/b-i.1.20' });
  assert.equal(session.pinned, true);
  assert.equal(session.canSwitchProduct, true);
});

test('collecting the same pinned product again uses the visible tab and follows navigation', () => {
  const session = new ProductSession();
  session.update({ id: 1, url: 'https://shopee.vn/a-i.1.10' });
  const old = session.begin();
  session.pinForAnalysis(old);
  session.finish(old);
  session.update({ id: 2, url: 'https://shopee.vn/a-i.1.10' });
  assert.equal(session.canSwitchProduct, false);
  const run = session.begin();
  assert.equal(run.tabId, 2);
  assert.equal(session.pinned, false);
  session.update({ id: 2, url: 'https://shopee.vn/b-i.1.20' });
  assert.equal(run.signal.aborted, true);
  assert.equal(session.pinForAnalysis(run), false);
  const next = session.begin();
  assert.equal(session.finish(old), false);
  assert.equal(session.isCurrent(next), true);
});
