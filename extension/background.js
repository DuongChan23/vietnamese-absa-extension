
"use strict";

import { productIdFromUrl } from "./services/product_context.js";
import { recordActivity, flushActivityLog } from "./services/activity_service.js";

const logActivity = (event, context, details, durationMs = null) => recordActivity({
  event, run_id: context.runId ?? null, product_id: context.productId ?? null,
  client_time: new Date().toISOString(), duration_ms: durationMs, details
});

// Mở Side Panel khi nhấn biểu tượng Extension.
function enableSidePanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();
void flushActivityLog();

const COLLECTORS = {
  COLLECT_SHOPEE_PRODUCT: "collectors/product_collector.js",
  COLLECT_SHOPEE_REVIEWS: "collectors/review_collector.js",
};
const collectionRuns = new Map();

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    if (message?.type === 'ABSA_LOG_ACTIVITY') {
      recordActivity(message.payload).then(sendResponse);
      return true;
    }
    if (message?.type === 'ABSA_FLUSH_LOGS') {
      flushActivityLog(Boolean(message.force)).then(status => sendResponse({ ok: true, status }));
      return true;
    }
    if (message?.type === "ABSA_COLLECTION_DONE") {
      const data = message.data || {};
      logActivity(data.ok ? 'collection_finished_in_page' : 'collection_failed_in_page', {
        runId: message.run_id, productId: message.product_id
      }, {
        collected: data.reviews?.length || 0,
        pages: data.stats?.pages_checked || 0,
        stop_reason: data.stats?.stop_reason || data.error || 'unknown'
      }, data.stats?.duration_ms ?? message.duration_ms ?? null).then(sendResponse);
      return true;
    }
    if (message?.type === "ABSA_COLLECTION_PROGRESS") {
      logActivity("collection_page", {
        runId: message.run_id, productId: message.product_id
      }, message.stats || {}, message.duration_ms)
        .then(sendResponse);
      return true;
    }
    if (message?.type === "CANCEL_SHOPEE_COLLECTION") {
      if (collectionRuns.get(message.tabId) === message.runId) collectionRuns.delete(message.tabId);
      chrome.scripting.executeScript({
        target: { tabId: message.tabId },
        func: (runId) => {
          if (document.documentElement.dataset.absaCollectionRun === runId) {
            delete document.documentElement.dataset.absaCollectionRun;
          }
        },
        args: [message.runId]
      }).then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    const file = COLLECTORS[message?.type];
    if (!file) return false;
    const isReviewCollection = message.type === "COLLECT_SHOPEE_REVIEWS";
    const collectionRunId = message.runId || crypto.randomUUID();
    if (isReviewCollection) collectionRuns.set(Number(message.tabId), collectionRunId);
    const assertRun = () => {
      if (isReviewCollection && collectionRuns.get(Number(message.tabId)) !== collectionRunId) {
        throw new Error('collection_cancelled');
      }
    };

    (async () => {
      const tabId = Number(message.tabId);

      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error("invalid_tab_id");
      }

      const tab = await chrome.tabs.get(tabId);
      assertRun();
      if (!tab.url) {
        throw new Error("tab_url_unavailable");
      }

      const url = new URL(tab.url);
      const isShopee =
        url.protocol === "https:" &&
        (url.hostname === "shopee.vn" ||
          url.hostname.endsWith(".shopee.vn"));

      if (!isShopee) {
        throw new Error("not_shopee_vietnam");
      }
      const productId = productIdFromUrl(tab.url);
      if (!productId || (message.productId && message.productId !== productId)) {
        throw new Error("product_changed");
      }

      // Truyền lựa chọn số lượng cho Review Collector.
      if (message.type === "COLLECT_SHOPEE_REVIEWS") {
        const requested = Number(message.limit);
        const limit = message.limit === "all" ? "all" : [50, 100, 200].includes(requested)
          ? requested
          : 50;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (value, runId, expectedProductId) => {
            document.documentElement.dataset.absaReviewLimit =
              String(value);
            document.documentElement.dataset.absaCollectionRun = runId;
            document.documentElement.dataset.absaExpectedProduct = expectedProductId;
          },
          args: [limit, collectionRunId, productId],
        });
        assertRun();
      }

      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        files: ['collectors/review_helpers.js', file],
      });
      const current = await chrome.tabs.get(tabId);
      assertRun();
      if (productIdFromUrl(current.url) !== productId) {
        throw new Error("product_changed");
      }

      return injected?.[0]?.result ?? {
        ok: false,
        error: "collector_no_result",
      };
    })()
      .finally(() => {
        if (isReviewCollection && collectionRuns.get(Number(message.tabId)) === collectionRunId) {
          collectionRuns.delete(Number(message.tabId));
        }
      })
      .then(sendResponse)
      .catch((error) => {
        console.error("Shopee Collector:", error);
        sendResponse({
          ok: false,
          error: error.message || String(error),
        });
      });

    return true;
  }
);
