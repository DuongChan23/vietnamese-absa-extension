import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = (await Promise.all(['review_helpers.js', 'review_collector.js'].map(file =>
  fs.readFile(new URL(`../extension/collectors/${file}`, import.meta.url), 'utf8')
))).join('\n');

function collectorFixture({ pages = 3, startPage = 1, limit = 'all', emptyPages = [],
  cancelAtSleep = 0, filtered = false, hasAllFilter = true, misleadingPrevious = false,
  identicalCards = false, noActivePage = false, disabledAttributeOnly = false,
  blockedReset = false, hasCommentFilter = false, contentsByPage = {},
  nativeRatingCounts = null, contentNodesMissing = false, commentsInitiallySelected = false } = {}) {
  let page = startPage;
  let now = 0;
  let sleeps = 0;
  let allSelected = !filtered && !commentsInitiallySelected;
  let commentsSelected = commentsInitiallySelected;
  const clicks = [];
  const messages = [];
  const dataset = { absaReviewLimit: String(limit), absaCollectionRun: 'run-1', absaExpectedProduct: '1.10' };
  const element = (text = '', attributes = {}) => ({
    textContent: text, innerText: text, children: [], isConnected: true,
    classList: { contains: () => false },
    getClientRects: () => [{}],
    getAttribute: key => attributes[key] ?? null,
    querySelector: () => null, querySelectorAll: () => [],
    contains: () => false,
    compareDocumentPosition: () => 0,
    matches: () => false,
  });
  const nav = direction => ({
    ...element(),
    get disabled() {
      if (disabledAttributeOnly || (direction === 'previous' && misleadingPrevious)) return false;
      return direction === 'next' ? page >= pages : page === 1;
    },
    getAttribute(key) {
      return key === 'disabled' && disabledAttributeOnly &&
        (direction === 'next' ? page >= pages : page === 1) ? '' : null;
    },
    click() { clicks.push(direction); page += direction === 'next' ? 1 : -1; },
  });
  const next = nav('next');
  const previous = nav('previous');
  const first = { ...element('1'), click() { clicks.push('first'); if (!blockedReset) page = 1; } };
  const allFilter = {
    ...element(nativeRatingCounts ? `Tất cả (${Object.values(nativeRatingCounts).reduce((a,b) => a+b,0)})` : 'Tất cả'),
    classList: { contains: name => name.endsWith('--active') && allSelected },
    click() { clicks.push('all'); allSelected = true; commentsSelected = false; page = 1; },
  };
  const commentFilter = {
    ...element('Có bình luận (4)'),
    classList: { contains: name => name.endsWith('--active') && commentsSelected },
    click() { clicks.push('comments'); commentsSelected = true; allSelected = false; page = 1; },
  };
  function cards() {
    const id = `${identicalCards ? 1 : page}`;
    const text = Object.hasOwn(contentsByPage, page) ? contentsByPage[page] :
      emptyPages.includes(page) ? '' : `Bình luận số ${id} về sản phẩm rất tốt.`;
    const card = element(`user${id}\n2026-11-01 12:00\n${text || 'Phân loại hàng: Đen'}`, { 'data-rating-id': id });
    const row = element();
    row.parentElement = card;
    const content = element(text);
    const author = element(`user${id}`);
    const rating = element('', { 'data-rating': '5' });
    card.querySelector = selector => selector.includes('content') ? (contentNodesMissing ? null : content) :
      selector.includes('author') ? author : null;
    card.querySelectorAll = selector => selector.includes('[aria-label]') ? [rating] : [];
    return { card, row };
  }
  const root = {
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === '.d72He7') return [cards().row];
      if (selector.includes('filter')) return [
        ...(hasAllFilter ? [allFilter] : []), ...(hasCommentFilter ? [commentFilter] : []),
        ...Object.entries(nativeRatingCounts || {}).map(([star, count]) =>
          element(`${star} sao (${commentsSelected ? 1 : count})`))
      ];
      if (selector === '.shopee-page-controller button') {
        const active = element(String(page), noActivePage ? {} : { 'aria-current': 'page' });
        return [first, active];
      }
      if (selector.includes('--right')) return [next];
      if (selector.includes('--left')) return [previous];
      return [];
    }
  };
  const heading = { ...element('ĐÁNH GIÁ SẢN PHẨM'), closest: () => root, scrollIntoView() {} };
  const document = {
    documentElement: { dataset },
    querySelectorAll: () => [heading],
    body: {},
  };
  class FakeDate extends Date { static now() { return 1_700_000_000_000 + now; } }
  let complete;
  const context = {
    document, location: { href: 'https://shopee.vn/a-i.1.10' }, URL,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    performance: { now: () => now }, Date: FakeDate,
    setTimeout(callback, ms) {
      now += ms;
      sleeps++;
      if (sleeps === cancelAtSleep) dataset.absaCollectionRun = 'new-run';
      queueMicrotask(callback);
    },
    chrome: { runtime: { sendMessage: async message => {
      if (message.type === 'ABSA_COLLECTION_DONE') complete(message.data);
      else messages.push(message);
    } } },
  };
  return { run: () => new Promise(resolve => {
    complete = resolve;
    const ack = vm.runInNewContext(source, context);
    assert.equal(ack.started, true);
  }), clicks, messages };
}

test('all mode reads beyond 65 pages and stops at the disabled next button', async () => {
  const fixture = collectorFixture({ pages: 70 });
  const result = await fixture.run();
  assert.equal(result.reviews.length, 70);
  assert.equal(result.stats.pages_checked, 70);
  assert.equal(result.stats.max_pages, null);
  assert.equal(result.stats.target, null);
  assert.equal(result.stats.stop_reason, 'end_of_reviews');
  assert.equal(fixture.messages.length, 70);
  assert.equal(fixture.messages.at(-1).stats.collected, 70);
});

test('collection returns to the first page before reading reviews', async () => {
  const fixture = collectorFixture({ pages: 4, startPage: 3 });
  const result = await fixture.run();
  assert.equal(result.reviews.length, 4);
  assert.equal(result.reviews[0].review_id, '1');
  assert.equal(fixture.clicks[0], 'first');
});

test('all mode removes the existing rating filter', async () => {
  const fixture = collectorFixture({ pages: 4, startPage: 3, filtered: true });
  const result = await fixture.run();
  assert.equal(result.reviews.length, 4);
  assert.equal(fixture.clicks[0], 'all');
});

test('all mode continues past pages without textual reviews', async () => {
  const result = await collectorFixture({ pages: 4, emptyPages: [2, 3] }).run();
  assert.deepEqual(Array.from(result.reviews, row => row.review_id), ['1', '4']);
  assert.equal(result.stats.pages_checked, 4);
});

test('fixed limits still stop after the chosen number of reviews', async () => {
  const result = await collectorFixture({ pages: 70, limit: 50 }).run();
  assert.equal(result.reviews.length, 50);
  assert.equal(result.stats.stop_reason, 'target_reached');
});

test('cancellation during a page wait stops the collector', async () => {
  const fixture = collectorFixture({ pages: 5, cancelAtSleep: 2 });
  const result = await fixture.run();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'collection_cancelled_or_product_changed');
  assert.equal(fixture.messages.length, 1);
  assert.equal(fixture.clicks.length, 1);
});

test('all mode reports a missing all-rating filter instead of silently taking a subset', async () => {
  const result = await collectorFixture({ hasAllFilter: false }).run();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'all_rating_filter_not_found');
});

test('an enabled-looking previous arrow on page 1 does not trigger a failing reset', async () => {
  const fixture = collectorFixture({ pages: 4, limit: 50, misleadingPrevious: true });
  const result = await fixture.run();
  assert.equal(result.ok, true);
  assert.equal(result.reviews.length, 4);
  assert.equal(fixture.clicks.includes('first'), false);
});

test('page markers confirm navigation even when review content is identical', async () => {
  const fixture = collectorFixture({ pages: 4, startPage: 3, identicalCards: true });
  const result = await fixture.run();
  assert.equal(result.ok, true);
  assert.equal(result.stats.pages_checked, 4);
  assert.equal(result.stats.stop_reason, 'end_of_reviews');
});

test('disabled attributes on non-native arrow elements prevent clicks past the last page', async () => {
  const fixture = collectorFixture({ pages: 3, noActivePage: true, disabledAttributeOnly: true });
  const result = await fixture.run();
  assert.equal(result.ok, true);
  assert.equal(result.stats.stop_reason, 'end_of_reviews');
  assert.equal(result.reviews.length, 3);
  assert.equal(fixture.clicks.filter(value => value === 'next').length, 2);
});

test('a reset that really fails away from page 1 still reports incomplete collection', async () => {
  const result = await collectorFixture({ startPage: 3, blockedReset: true }).run();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'first_page_not_confirmed');
});

test('only written comments count toward the requested target, including short comments', async () => {
  const result = await collectorFixture({ pages: 5, limit: 50, contentsByPage: {
    1: '', 2: '5 sao\nHữu ích (0)\n0', 3: 'Người dùng không để lại bình luận.',
    4: 'ok', 5: '👍'
  } }).run();
  assert.deepEqual(Array.from(result.reviews, row => row.text), ['ok', '👍']);
  assert.equal(result.stats.pages_checked, 5);
  assert.equal(result.stats.skipped_without_comment, 3);
});

test('fixed targets continue after two pages of star-only ratings', async () => {
  const result = await collectorFixture({ pages: 4, limit: 50, emptyPages: [1, 2] }).run();
  assert.equal(result.reviews.length, 2);
  assert.equal(result.stats.pages_checked, 4);
});

test('the comment filter is preferred and native star counts are captured before filtering', async () => {
  const native = { 1: 2, 2: 3, 3: 5, 4: 20, 5: 70 };
  const fixture = collectorFixture({ hasCommentFilter: true, nativeRatingCounts: native });
  const result = await fixture.run();
  assert.equal(fixture.clicks[0], 'comments');
  assert.equal(result.stats.review_filter, 'with_comments');
  assert.deepEqual({ ...result.rating_summary.counts }, native);
  assert.equal(result.rating_summary.total, 100);
});

test('fallback does not mistake stars, product variations or seller replies for comments', async () => {
  const result = await collectorFixture({ pages: 3, contentNodesMissing: true, contentsByPage: {
    1: 'Phân loại hàng: Đen\n5 sao\n★★★★★\nHữu ích (0)\n0',
    2: 'Phản Hồi Của Người Bán:\nCảm ơn bạn đã mua hàng',
    3: 'Áo đẹp.'
  } }).run();
  assert.deepEqual(Array.from(result.reviews, row => row.text), ['Áo đẹp.']);
});

test('a previous comment-filter selection is cleared before reading overall Shopee stars', async () => {
  const native = { 1: 2, 2: 3, 3: 5, 4: 20, 5: 70 };
  const fixture = collectorFixture({
    hasCommentFilter: true, nativeRatingCounts: native, commentsInitiallySelected: true,
  });
  const result = await fixture.run();
  assert.deepEqual(fixture.clicks.slice(0, 2), ['all', 'comments']);
  assert.deepEqual({ ...result.rating_summary.counts }, native);
});
