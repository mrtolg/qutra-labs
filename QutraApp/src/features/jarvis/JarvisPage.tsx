import { lazy, Suspense } from "react";
import { usePreferences } from "@/lib/db/database";
import { useT } from "@/lib/i18n";
import { JarvisHistory } from "./JarvisHistory";
import { useJarvisUi } from "./jarvisUi";
import { LocalAssistantChat } from "./LocalAssistantChat";

// Opened on demand, so its code loads then.
const JarvisSettings = lazy(() => import("./JarvisSettings"));

/**
 * The Jarvis page: the history of
 * conversations on the left, which the top bar's row shows or hides, and
 * the open conversation beside it — its header, the transcript and the
 * composer. Jarvis's own settings open over it from the right.
 */
export default function JarvisPage() {
  const { t } = useT();
  const historyOpen = usePreferences().jarvisHistoryOpen;
  const settingsOpen = useJarvisUi((state) => state.settings !== null);
  return (
    <div className="page asst-page">
      <h1 className="sr-only">{t("jarvis.title")}</h1>
      <div className="jv">
        {historyOpen && <JarvisHistory />}
        <LocalAssistantChat />
      </div>
      {settingsOpen && (
        <Suspense fallback={null}>
          <JarvisSettings />
        </Suspense>
      )}
    </div>
  );
}
