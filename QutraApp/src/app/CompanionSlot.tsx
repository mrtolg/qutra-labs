import { lazy, Suspense } from "react";
import { usePreferences } from "@/lib/db/database";
import { withDeferredCopy } from "@/lib/i18n";

// The "Beni takip et" bubble, in its own chunk and fetched only once it is on.
const Companion = lazy(withDeferredCopy(() => import("@/features/companion/Companion")));

export function CompanionSlot() {
  const on = usePreferences().companionEnabled;
  if (!on) return null;
  return (
    <Suspense fallback={null}>
      <Companion />
    </Suspense>
  );
}
