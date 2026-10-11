import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { usePreferences } from "@/lib/db/database";

export function RequireOnboarding({ children }: { children: ReactNode }) {
  const prefs = usePreferences();
  if (!prefs.onboardingDone) {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
}
