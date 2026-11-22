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
  pageContext = null;
  pinned = false;
  revision = 0;
  run = null;

  get canSwitchProduct() {
    return Boolean(this.pinned && this.pageContext?.productId &&
      this.pageContext.productId !== this.context?.productId);
  }

  update(tab, { switchProduct = false } = {}) {
    const productId = productIdFromUrl(tab?.url);
    const key = `${tab?.id ?? "none"}:${productId ?? "none"}`;
    this.pageContext = { key, tabId: tab?.id, productId, url: tab?.url };
    if (this.pinned) {
      if (!switchProduct || !this.canSwitchProduct) return false;
      this.pinned = false;
    }
    if (key === this.context?.key) return false;
    this.cancel();
    this.revision++;
    this.context = { ...this.pageContext };
    return true;
  }

  begin(stage = "collecting") {
    if (stage === "collecting" && this.pinned) {
      if (this.pageContext?.productId !== this.context?.productId) {
        throw new Error("product_switch_required");
      }
      // A fresh collection follows navigation again. Use the visible tab even
      // if the same product was opened in a different tab while pinned.
      this.pinned = false;
      this.update({ id: this.pageContext.tabId, url: this.pageContext.url });
    }
    this.cancel();
    const controller = new AbortController();
    this.run = {
      ...this.context, revision: this.revision, stage,
      runId: crypto.randomUUID(), controller, signal: controller.signal
    };
    return this.run;
  }

  isCurrent(run) {
    return this.run === run && this.revision === run.revision && !run.signal.aborted;
  }

  pinForAnalysis(run) {
    if (!this.isCurrent(run)) return false;
    run.stage = "analyzing";
    this.pinned = true;
    return true;
  }

  finish(run) {
    if (this.run !== run) return false;
    this.run = null;
    // Keep the product pinned after success, failure or user cancellation.
    return true;
  }

  cancel() {
    this.run?.controller.abort();
    this.run = null;
  }
}
