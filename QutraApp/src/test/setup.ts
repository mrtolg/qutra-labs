import { Buffer } from "node:buffer";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { setDbForTesting } from "@/lib/db/database";
import { registerDeferredCopy } from "@/lib/i18n";
import { deferredEn } from "@/lib/i18n/deferred/en";
import { deferredTr } from "@/lib/i18n/deferred/tr";
import { deferredDe } from "@/lib/i18n/deferred/de";
import { deferredEs } from "@/lib/i18n/deferred/es";
import { deferredFr } from "@/lib/i18n/deferred/fr";
import { deferredIt } from "@/lib/i18n/deferred/it";

// jsdom does not implement <dialog> showModal/close; minimal polyfill.
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
}

// jsdom's Blob has no arrayBuffer() (WebView2's does); read it through FileReader.
if (typeof Blob !== "undefined" && !Blob.prototype.arrayBuffer) {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      // Copied into Node's realm: jsdom makes the result in its window's
      // realm, which CI's Node 20 webcrypto refuses (src/test/setup.test.ts).
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        const copy = Buffer.alloc(bytes.byteLength);
        copy.set(bytes);
        resolve(copy.buffer);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

// The words lazy pages read load after the first paint in the app
// (src/lib/i18n/deferred); a test renders those pages directly, so it has
// them from the start, in every language.
registerDeferredCopy("en", deferredEn);
registerDeferredCopy("tr", deferredTr);
registerDeferredCopy("de", deferredDe);
registerDeferredCopy("es", deferredEs);
registerDeferredCopy("fr", deferredFr);
registerDeferredCopy("it", deferredIt);

afterEach(() => {
  cleanup();
  setDbForTesting(null);
  localStorage.clear();
});
