import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { sha256HexBytes } from "@/lib/hash";

/* The test setup's polyfills behave as WebView2 does. jsdom makes a
   FileReader's ArrayBuffer in its window's realm; CI's Node 20 webcrypto
   refuses one from another realm, while Node 22 (local) accepts it. Node's
   own ArrayBuffer is the one webcrypto checks against. */
const NodeArrayBuffer = Buffer.alloc(1).buffer.constructor as ArrayBufferConstructor;

describe("Blob.prototype.arrayBuffer in tests", () => {
  it("gives the bytes as an ArrayBuffer Node's webcrypto takes on every version", async () => {
    const buffer = await new Blob(["abc"]).arrayBuffer();
    expect(buffer instanceof NodeArrayBuffer).toBe(true);
    expect([...new Uint8Array(buffer)]).toEqual([97, 98, 99]);
  });

  it("can be hashed by webcrypto", async () => {
    const buffer = await new File(["abc"], "a.txt").arrayBuffer();
    expect(await sha256HexBytes(buffer)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
