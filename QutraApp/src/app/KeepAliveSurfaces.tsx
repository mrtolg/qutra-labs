import { lazy, useEffect, useState } from "react";
import { withDeferredCopy } from "@/lib/i18n";
import { Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/app/ErrorBoundary";
import { Load } from "@/app/Load";
import TerminalPage from "@/features/terminal/TerminalPage";
import { closeManagedTerminals } from "@/features/terminal/managedTerminals";

/* Jarvis mounts on its first visit anyway, so its code loads then too,
   outside the first-paint bundle. */
const JarvisPage = lazy(withDeferredCopy(() => import("@/features/jarvis/JarvisPage")));

/* Terminal and assistant turns must outlive the route that first showed
   them. Unmount of a retained owner is not navigation, and it
   is not by itself app quit or Private Lab revocation. Tab close, an error
   boundary taking over a retained owner, and owner teardown still dispose.
   Private Lab revoke closes managed PTYs even when Terminal was never
   visited. Orderly shutdown reuses abandonPreviousRendererWork. */

export function KeepAliveSurfaces() {
  const { pathname } = useLocation();
  const [mounted, setMounted] = useState({
    terminal: pathname === "/terminal",
    jarvis: pathname === "/jarvis",
  });

  const terminalActive = pathname === "/terminal";
  const jarvisActive = pathname === "/jarvis";

  if (terminalActive && !mounted.terminal) {
    setMounted((current) => ({ ...current, terminal: true }));
  }
  if (jarvisActive && !mounted.jarvis) {
    setMounted((current) => ({ ...current, jarvis: true }));
  }

  const terminalMounted = mounted.terminal || terminalActive;
  const jarvisMounted = mounted.jarvis || jarvisActive;

  useEffect(() => {
    if (!terminalActive) return;
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => cancelAnimationFrame(frame);
  }, [terminalActive]);

  return (
    <>
      {terminalMounted && (
        <div
          className="keep-alive-page"
          hidden={!terminalActive}
          data-testid="keepalive-terminal"
        >
          <ErrorBoundary
            onError={() => {
              void closeManagedTerminals();
            }}
          >
            <TerminalPage />
          </ErrorBoundary>
        </div>
      )}
      {jarvisMounted && (
        <div
          className="keep-alive-page"
          hidden={!jarvisActive}
          data-testid="keepalive-jarvis"
        >
          <ErrorBoundary>
            <Load>
              <JarvisPage />
            </Load>
          </ErrorBoundary>
        </div>
      )}
      {terminalActive || jarvisActive ? null : (
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      )}
    </>
  );
}
