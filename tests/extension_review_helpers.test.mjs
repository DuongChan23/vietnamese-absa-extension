import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { buildAnalytics } from '../extension/services/analytics_service.js';

const source = await fs.readFile(new URL('../extension/collectors/review_helpers.js', import.meta.url), 'utf8');
const context = vm.createContext({
  getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
});
vm.runInContext(source, context);
const { buyerText, extractBuyerComment, readShopeeRatingSummary } = context.__absaReviewHelpers;
const node = (value, attributes = {}) => ({
  innerText: value, textContent: value, isConnected: true,
  getClientRects: () => [{}], getAttribute: key => attributes[key] ?? null,
});
const ratingRoot = labels => ({
  querySelectorAll: () => labels.map(label => node(label)), querySelector: () => null,
});

test('stars, generated empty-review messages, toolbar counters and variations are not comments', () => {
  for (const value of ['', '   ', '★★★★★', '5 sao\nHữu ích (0)\n0',
    'Phân loại hàng: Đen, L', 'Người dùng không để lại bình luận.',
    'Không có bình luận', 'Video\n0:05', 'Phản Hồi Của Người Bán:\nCảm ơn bạn',
    'Màu sắc: Đen\nKích cỡ: L', 'Chất liệu:\nĐúng với mô tả: —\nĐã mua hàng']) {
    assert.equal(buyerText(value), null, value);
  }
});

test('written short comments, emoji and buyer-entered attribute feedback are kept', () => {
  for (const value of ['ok', 'tốt', '👍', 'ổ', 'Chất liệu: mềm, mặc mát',
    'Phản hồi của người bán rất nhanh']) {
    assert.equal(buyerText(value), value);
  }
});

test('an empty content node cannot fall back to surrounding stars or a seller reply', () => {
  const card = {
    innerText: 'user\n2026-11-01 12:00\n5 sao\nPhản Hồi Của Người Bán:\nCảm ơn bạn',
    querySelector: selector => selector.includes('content') ? node('') : null,
  };
  assert.equal(extractBuyerComment(card), null);
});

test('native star bucket counts and overall totals are read from Shopee filters', () => {
  const summary = readShopeeRatingSummary(ratingRoot([
    'Tất cả (1.240)', '5 sao (1.000)', '4 sao (200)', '3 sao (30)', '2 sao (8)', '1 sao (2)'
  ]), { average: 4.76 });
  assert.deepEqual({ ...summary.counts }, { 1: 2, 2: 8, 3: 30, 4: 200, 5: 1000 });
  assert.equal(summary.total, 1240);
  assert.equal(summary.average, 4.76);
  assert.equal(summary.approximate, false);
});

test('compact counts are marked approximate and absent buckets stay unknown', () => {
  const summary = readShopeeRatingSummary(ratingRoot(['Tất cả (2,4k)', '5 sao (2,1k)', '1 sao (0)']));
  assert.equal(summary.total, 2400);
  assert.equal(summary.counts[5], 2100);
  assert.equal(summary.counts[1], 0);
  assert.equal(summary.counts[4], null);
  assert.equal(summary.approximate, true);
  assert.equal(summary.total_approximate, true);
  assert.equal(summary.distribution_available, false);
});

test('native ratings do not change when the collected comment sample changes', () => {
  const native = { counts: { 1: 2, 2: 8, 3: 30, 4: 200, 5: 1000 }, total: 1240, average: 4.76 };
  const oneStarSample = Array.from({ length: 50 }, () => ({ text: 'tệ', rating: 1 }));
  const fiveStarSample = [{ text: 'tốt', rating: 5 }];
  const first = buildAnalytics({ results: [] }, oneStarSample, native);
  const second = buildAnalytics({ results: [] }, fiveStarSample, native);
  assert.deepEqual(first.ratings, second.ratings);
  assert.equal(first.ratings.total, 1240);
  assert.equal(first.ratings.average, 4.76);
  assert.equal(first.ratings.counts[1], 2);
  assert.equal(first.collected, 50);
});

test('missing native statistics never become fabricated zero counts or a sample average', () => {
  const analytics = buildAnalytics({ results: [] }, [{ text: 'tốt', rating: 5 }]);
  assert.equal(analytics.ratings.average, null);
  assert.equal(analytics.ratings.total, null);
  assert.equal(analytics.ratings.counts[5], null);
  assert.equal(analytics.ratings.distributionAvailable, false);
});
