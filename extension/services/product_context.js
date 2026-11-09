"use strict";

export function productIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
        !/(^|\.)shopee\.vn$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/-i\.(\d+)\.(\d+)(?:\/|$)/) ||
      url.pathname.match(/^\/product\/(\d+)\/(\d+)(?:\/|$)/);
    if (match) return `${match[1]}.${match[2]}`;
    const shop = url.searchParams.get("shopid");
    const item = url.searchParams.get("itemid");
    return /^\d+$/.test(shop || "") && /^\d+$/.test(item || "")
      ? `${shop}.${item}` : null;
  } catch {
    return null;
  }
}

export class ProductSession {
  context = null;
  revision = 0;
  run = null;

  update(tab) {
    const productId = productIdFromUrl(tab?.url);
    const key = `${tab?.id ?? "none"}:${productId ?? "none"}`;
    if (key === this.context?.key) return false;
    this.cancel();
    this.revision++;
    this.context = { key, tabId: tab?.id, productId, url: tab?.url };
    return true;
  }

  begin() {
    this.cancel();
    const controller = new AbortController();
    this.run = {
      ...this.context, revision: this.revision,
      runId: crypto.randomUUID(), controller, signal: controller.signal
    };
    return this.run;
  }

  isCurrent(run) {
    return this.run === run && this.revision === run.revision && !run.signal.aborted;
  }

  cancel() {
    this.run?.controller.abort();
    this.run = null;
  }
}
