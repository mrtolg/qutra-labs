import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Git-ignored record of the Vite dev server this checkout started. The gate
 * (scripts/e2e-port-owner.ps1) stops a process on the e2e port only when its
 * PID and OS start time match this record; it never guesses from a command line.
 */
export const DEV_SERVER_OWNER_FILE = ".qutra-dev-server.json";

export interface DevServerOwner {
  pid: number;
  port: number;
  /** performance.timeOrigin: a few ms after the OS created the process. */
  startedAtMs: number;
  /** When the record was written. A process with this PID that started later is not ours. */
  recordedAtMs: number;
}

export function writeDevServerOwner(root: string, owner: DevServerOwner): void {
  const record: DevServerOwner = {
    pid: owner.pid,
    port: owner.port,
    startedAtMs: Math.floor(owner.startedAtMs),
    recordedAtMs: Math.ceil(owner.recordedAtMs),
  };
  writeFileSync(path.join(root, DEV_SERVER_OWNER_FILE), `${JSON.stringify(record)}\n`);
}

function removeOwnRecord(root: string): void {
  const file = path.join(root, DEV_SERVER_OWNER_FILE);
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as Partial<DevServerOwner>;
    if (record.pid === process.pid) rmSync(file, { force: true });
  } catch {
    // No record, or one this process cannot read: nothing of ours to remove.
  }
}

/** Records the listening dev server's PID so the gate can tell it from anyone else's. */
export function devServerOwner(): Plugin {
  return {
    name: "qutra-dev-server-owner",
    apply: "serve",
    configureServer(server) {
      const httpServer = server.httpServer;
      // Vitest builds a server too but never listens, so it records nothing.
      if (!httpServer) return;
      const root = server.config.root;
      httpServer.once("listening", () => {
        const address = httpServer.address() as AddressInfo | string | null;
        if (!address || typeof address === "string") return;
        writeDevServerOwner(root, {
          pid: process.pid,
          port: address.port,
          startedAtMs: performance.timeOrigin,
          recordedAtMs: Date.now(),
        });
      });
      httpServer.once("close", () => removeOwnRecord(root));
    },
  };
}
