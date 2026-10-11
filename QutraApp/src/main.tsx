import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./app/router";
import { initDb, getDb } from "./lib/db/database";
import { preloadTauriBridge } from "./lib/bridge";
import { abandonPreviousRendererWork, installRendererShutdown } from "./lib/lifecycle";
import { detectRuntime } from "./lib/runtime";
import { installExternalLinksForDesktop } from "./lib/externalLinks";
import { detectLocale, ensureLocaleLoaded } from "./lib/i18n";
import { setRegionalFormatSource } from "./lib/regionalFormat";
import { BootScreen } from "./app/BootScreen";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/motion.css";

const rootEl = document.getElementById("root")!;
const root = createRoot(rootEl);

async function boot() {
  // Desktop: show a boot screen while SQLite opens and the native bridge
  // registers. Browser: this resolves effectively instantly.
  if (detectRuntime() === "tauri") {
    root.render(
      <StrictMode>
        <BootScreen />
      </StrictMode>,
    );
  }

  try {
    await preloadTauriBridge();
    await abandonPreviousRendererWork();
    const db = await initDb();
    // Dates, times and numbers follow Settings › Language & region.
    setRegionalFormatSource(() => db.prefs.get());
    // First launch: pick locale from the OS/browser (explicit setting wins later).
    if (!db.storage.read("preferences")) {
      db.prefs.set({ locale: detectLocale() });
    }
    await ensureLocaleLoaded(db.prefs.get().locale);
  } catch (err) {
    console.error("[Qutra Labs] boot failed:", err);
    root.render(
      <StrictMode>
        <BootScreen error={String(err)} />
      </StrictMode>,
    );
    return;
  }

  root.render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}

void boot();

installRendererShutdown();
installExternalLinksForDesktop();

// Keep a reference so tree-shaking never drops the eager singleton helper.
void getDb;
