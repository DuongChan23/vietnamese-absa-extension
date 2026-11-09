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
