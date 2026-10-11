import { Suspense, type ReactNode } from "react";

/** A lazy page's place while its chunk loads. */
export function Load({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="page" aria-busy="true">
          <div className="page-header">
            <div className="skeleton" style={{ width: 180, height: 24 }} />
          </div>
          <div className="page-body stack" style={{ gap: 12 }}>
            <div className="skeleton" style={{ height: 96 }} />
            <div className="skeleton" style={{ height: 200 }} />
          </div>
        </div>
      }
    >
      {children}
    </Suspense>
  );
}
