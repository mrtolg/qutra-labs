import type {
  NativeDetectedTool,
  NativeToolInstallation,
  NativeToolRun,
  NativeToolRunEvent,
} from "@/lib/bridge/types";
import type { InvestigationFile } from "@/lib/investigationFiles";
import type { FormRunRequest, FormRunStarted } from "@/lib/toolForms";

/** A fake tool supervisor an end-to-end test page can hand the browser build
    through `window.__QUTRA_E2E_TOOLS__`, so the native tool screens can be
    seen and screenshot without the desktop runtime. Development builds only:
    a production bundle never reads it. */
export interface E2eToolsSeam {
  installations: NativeToolInstallation[];
  runs: NativeToolRun[];
  files?: InvestigationFile[];
  detect?(skipCatalogIds: string[]): NativeDetectedTool[];
  setEnabled?(id: string, enabled: boolean): NativeToolInstallation;
  runForm?(request: FormRunRequest): FormRunStarted;
  output?(runId: string, name: string): string;
  onEvent?(listener: (event: NativeToolRunEvent) => void): void;
}

export function e2eTools(): E2eToolsSeam | undefined {
  if (!import.meta.env.DEV || typeof window === "undefined") return undefined;
  return (window as unknown as { __QUTRA_E2E_TOOLS__?: E2eToolsSeam }).__QUTRA_E2E_TOOLS__;
}
