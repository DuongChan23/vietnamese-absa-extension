
"use strict";

// Mở Side Panel khi nhấn biểu tượng Extension.
function enableSidePanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(console.error);
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();

const COLLECTORS = {
  COLLECT_SHOPEE_PRODUCT: "collectors/product_collector.js",
  COLLECT_SHOPEE_REVIEWS: "collectors/review_collector.js",
};

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {
    const file = COLLECTORS[message?.type];
    if (!file) return false;

    (async () => {
      const tabId = Number(message.tabId);

      if (!Number.isInteger(tabId) || tabId <= 0) {
        throw new Error("invalid_tab_id");
      }

      const tab = await chrome.tabs.get(tabId);
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

      // Truyền lựa chọn số lượng cho Review Collector.
      if (message.type === "COLLECT_SHOPEE_REVIEWS") {
        const requested = Number(message.limit);
        const limit = [50, 100, 200].includes(requested)
          ? requested
          : 50;

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (value) => {
            document.documentElement.dataset.absaReviewLimit =
              String(value);
          },
          args: [limit],
        });
      }

      const injected = await chrome.scripting.executeScript({
        target: { tabId },
        files: [file],
      });

      return injected?.[0]?.result ?? {
        ok: false,
        error: "collector_no_result",
      };
    })()
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
