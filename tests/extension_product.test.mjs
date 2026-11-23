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


test('product collector extracts JSON-LD breadcrumb names and category IDs', () => {
  const product = {'@type':'Product',url:'https://shopee.vn/a-i.1.20',name:'Áo thun Coolmate',offers:{price:139000}};
  const breadcrumb = {'@type':'BreadcrumbList',itemListElement:[
    {'@type':'ListItem',position:1,name:'Thời Trang Nam',item:'https://shopee.vn/category?categoryid=1001'},
    {'@type':'ListItem',position:2,name:'Áo',item:'https://shopee.vn/category?categoryid=1002'},
    {'@type':'ListItem',position:3,name:'Áo Thun',item:'https://shopee.vn/category?categoryid=1003'}
  ]};
  const scripts=[product,breadcrumb].map(value=>({textContent:JSON.stringify(value)}));
  const heading={textContent:'Áo thun Coolmate',getBoundingClientRect:()=>({width:500,height:30})};
  const result=vm.runInNewContext(source,{
    URL,window:{location:{href:'https://shopee.vn/a-i.1.20'}},
    getComputedStyle:()=>({display:'block',visibility:'visible'}),
    document:{
      title:'Current title',
      querySelector:selector=>selector.includes('canonical')?{href:'https://shopee.vn/a-i.1.20'}:heading,
      querySelectorAll:selector=>selector.includes('ld+json')?scripts:selector==='h1'?[heading]:[]
    }
  });
  assert.deepEqual(Array.from(result.category_path),['Thời Trang Nam','Áo','Áo Thun']);
  assert.deepEqual(Array.from(result.category_ids),['1001','1002','1003']);
  assert.equal(result.category_source,'jsonld_breadcrumb');
});
