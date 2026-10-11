import { useEffect, useMemo, useRef } from "react";
import type { Engagement } from "@/domain/lab";
import { useCollection } from "@/lib/db/database";
import { engagementFolders } from "@/lib/engagementFolders";

/** The copy of an engagement's records kept in its folder. */
export const ENGAGEMENT_RECORD_FILE = "qutra-engagement.json";
const SAVE_DELAY_MS = 1500;

/**
 * Keeps an up-to-date copy of the open engagement's records in its folder
 * (the app saves the engagement's data there by itself).
 * Written a moment after the last change, and only when something changed.
 * Records only: tool output and evidence files stay where they are kept.
 */
export function useEngagementAutosave(engagement: Engagement | undefined) {
  const scopes = useCollection("authorizationScopes");
  const targets = useCollection("targets");
  const findings = useCollection("findings");
  const evidence = useCollection("evidence");
  const reports = useCollection("reports");
  const saved = useRef<string | null>(null);

  const content = useMemo(() => {
    if (!engagement?.folderPath) return null;
    const mine = <T extends { engagementId?: string }>(items: readonly T[]) =>
      items.filter((item) => item.engagementId === engagement.id);
    return JSON.stringify({
      engagement,
      scope: scopes.find((s) => s.id === engagement.scopeId) ?? null,
      targets: mine(targets),
      findings: mine(findings),
      evidence: mine(evidence),
      reports: mine(reports),
    });
  }, [engagement, scopes, targets, findings, evidence, reports]);

  useEffect(() => {
    if (!engagement || !content || !engagementFolders.available()) return;
    if (saved.current === content) return;
    const id = engagement.id;
    const timer = window.setTimeout(() => {
      const document = {
        app: "Qutra Labs",
        kind: "security-engagement",
        version: 1,
        savedAt: new Date().toISOString(),
        ...(JSON.parse(content) as object),
      };
      engagementFolders.write(id, ENGAGEMENT_RECORD_FILE, JSON.stringify(document, null, 2)).then(
        () => {
          saved.current = content;
        },
        (caught: unknown) => console.error("engagement record not saved to its folder", caught),
      );
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [engagement, content]);
}
