/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { devServerOwner } from "./scripts/dev-server-owner";

/* The build stamp shown in Settings → About (src/lib/buildInfo.ts). Only
   tracked files count towards "dirty": untracked scratch folders are not
   part of the build, and neither are the e2e screenshots, which every gate
   run rewrites. */
function readBuildInfo() {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  return {
    commit: git("rev-parse", "--short=12", "HEAD") || "unknown",
    dirty:
      git("status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude)e2e/screenshots") !== "",
    builtAt: new Date().toISOString(),
  };
}

/** Dev server and Playwright share this port. Default 5174; a second checkout sets another. */
function e2ePort(): number {
  const raw = process.env.QUTRA_E2E_PORT;
  if (raw === undefined || raw === "") return 5174;
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(
      `QUTRA_E2E_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(
      `QUTRA_E2E_PORT must be an integer from 1 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return port;
}

// https://vite.dev/config/
export default defineConfig({
  // devServerOwner records the listening PID so the gate stops only its own Vite.
  plugins: [react(), devServerOwner()],
  define: {
    __QUTRA_BUILD__: JSON.stringify(readBuildInfo()),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // strictPort stays on: a taken port fails the run instead of hopping to
  // the next one while Playwright still asks for this origin. The desktop
  // app's devUrl in tauri.conf.json stays 5174 and does not follow this.
  server: {
    port: e2ePort(),
    strictPort: true,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 900,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    css: false,
  },
});
