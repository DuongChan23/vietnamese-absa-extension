import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await Promise.all(['review_helpers.js', 'product_collector.js'].map(file =>
  fs.readFile(new URL(`../extension/collectors/${file}`, import.meta.url), 'utf8')
))).join('\n');

function collectProduct({ schemaUrl = 'https://shopee.vn/a-i.1.20', canonicalUrl = schemaUrl } = {}) {
  const schema = {
    '@type': 'Product', url: schemaUrl, name: 'Schema name',
    offers: { price: 139000 }, aggregateRating: { ratingValue: 4.7, reviewCount: 2400 },
  };
  const heading = {
    textContent: 'Current visible product',
    getBoundingClientRect: () => ({ width: 500, height: 30 }),
  };
  return vm.runInNewContext(source, {
    URL, window: { location: { href: 'https://shopee.vn/a-i.1.20' } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: {
      title: 'Current title',
      querySelector: selector => selector.includes('canonical') ? { href: canonicalUrl } : heading,
      querySelectorAll: selector => selector.includes('ld+json') ? [{ textContent: JSON.stringify(schema) }] :
        selector === 'h1' ? [heading] : [],
    },
  });
}

test('product metadata prefers the visible title and uses the current product ID', () => {
  const result = collectProduct();
  assert.equal(result.ok, true);
  assert.equal(result.product_id, '1.20');
  assert.equal(result.name, 'Current visible product');
  assert.equal(result.review_count, 2400);
});

test('metadata left over from the previous SPA product is rejected', () => {
  assert.equal(collectProduct({ schemaUrl: 'https://shopee.vn/old-i.1.10' }).error, 'product_page_loading');
  assert.equal(collectProduct({ canonicalUrl: 'https://shopee.vn/old-i.1.10' }).error, 'product_page_loading');
});
