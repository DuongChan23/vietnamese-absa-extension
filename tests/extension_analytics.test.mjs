import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalytics } from '../extension/services/analytics_service.js';

test('merged results take priority and raw-only aliases match backend labels', () => {
  const result = buildAnalytics({ results: [
    { status: 'ok', aspects: [{ category: 'General', sentiment: 'positive' }], aspects_merged: [] },
    { status: 'ok', aspects: [{ category: 'SER&ACC', sentiment: 'negative' }] },
    { status: 'error', aspects: [{ category: 'Price', sentiment: 'positive' }] }
  ] }, []);
  assert.equal(result.totalAspects, 1);
  assert.equal(result.analyzed, 2);
  assert.equal(result.reviewsWithAspects, 1);
  assert.equal(result.categories[0].name, 'Service');
  assert.deepEqual(result.categoryNormalization, {
    policy: 'frontend_alias_fallback', usingMerged: 1, usingRaw: 1, fullyMerged: false
  });
});

test('prototype property names remain literal categories and invalid sentiments are ignored', () => {
  const result = buildAnalytics({ results: [{ status: 'ok', aspects: [
    { category: '__proto__', sentiment: 'positive' },
    { category: 'constructor', sentiment: 'negative' },
    { category: 'General', sentiment: 'unknown' }, null
  ] }] }, []);
  assert.deepEqual(result.categories.map(row => row.name).sort(), ['__proto__', 'constructor']);
  assert.equal(result.totalAspects, 2);
});
