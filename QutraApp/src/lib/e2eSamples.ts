import type { AddOutcome, InvestigationFile } from "@/lib/investigationFiles";

/** A stand-in for the sample generator that an end-to-end test page can hand
    the browser build through `window.__QUTRA_E2E_SAMPLES__`, so the Örnek
    veriler flow and the files it lands on can be seen and screenshot without
    the desktop runtime. Development builds only: a production bundle never
    reads it. */
export interface E2eSamplesSeam {
  generate(engagementId: string, samples: readonly string[]): AddOutcome[];
  files(engagementId: string): InvestigationFile[];
}

export function e2eSamples(): E2eSamplesSeam | undefined {
  if (!import.meta.env.DEV || typeof window === "undefined") return undefined;
  return (window as unknown as { __QUTRA_E2E_SAMPLES__?: E2eSamplesSeam })
    .__QUTRA_E2E_SAMPLES__;
}
