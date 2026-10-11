import type { Page } from "@playwright/test";

/* A lived-in app for screenshots: six investigations in every state, their
   scopes, targets and findings, and one project, in Turkish on the dark HUD
   theme. Seeded straight into the document store before the app boots;
   nothing here invents data the app would not have. Shared by the
   design-pages and design-shots screenshot specs. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function seedLivedIn(page: Page, { empty = false }: { empty?: boolean } = {}) {
  return page.addInitScript(
    ({ empty, MIN, HOUR, DAY }) => {
      const K = "contextos.v1.";
      const now = Date.now();
      const set = (name: string, rows: unknown[]) =>
        localStorage.setItem(K + name, JSON.stringify(rows));
      localStorage.setItem(
        K + "preferences",
        JSON.stringify({
          locale: "tr",
          theme: "system",
          packId: "hud",
          themeMode: "dark",
          material: "none",
          density: "comfortable",
          onboardingDone: true,
          privateToolsEnabled: true,
        }),
      );
      if (empty) return;

      const eng = (
        id: string,
        title: string,
        kind: string,
        status: string,
        ago: number,
        scopeId?: string,
      ) => ({
        id,
        title,
        kind,
        purpose: "training_lab",
        status,
        clientLabel: "",
        contacts: [],
        notes: "",
        tags: [],
        scopeId,
        demo: false,
        createdAt: now - ago - 3 * DAY,
        updatedAt: now - ago,
      });
      set("engagements", [
        eng("e-web", "Kurumsal portal — giriş testi", "web", "active", 18 * MIN, "sc-web"),
        eng("e-file", "Şüpheli fatura.pdf.exe", "file", "active", 2 * HOUR, "sc-file"),
        eng("e-pcap", "Ofis ağı trafik kaydı", "pcap", "paused", 26 * HOUR),
        eng("e-disk", "Muhasebe dizüstü disk imajı", "forensics", "completed", 3 * DAY, "sc-disk"),
        eng("e-host", "DMZ sunucuları", "host", "planned", 6 * DAY, "sc-host"),
        eng("e-old", "Eski kampanya alan adları", "web", "archived", 40 * DAY),
      ]);
      const scope = (id: string, engagementId: string, allowed: string[], ack: boolean) => ({
        id,
        engagementId,
        ownerLabel: "self",
        description: "",
        allowedTargets: allowed,
        excludedTargets: [],
        authorizationRef: "AUTH-2026-10",
        testerAck: ack,
        revision: 1,
        notes: "",
        demo: false,
        createdAt: now - 4 * DAY,
        updatedAt: now - 4 * DAY,
      });
      set("authorizationScopes", [
        scope("sc-web", "e-web", ["portal.example.com", "api.example.com"], true),
        scope("sc-file", "e-file", [], true),
        scope("sc-disk", "e-disk", [], true),
        // A target outside the allowed list: runs are blocked here.
        scope("sc-host", "e-host", ["10.0.5.0/24"], true),
      ]);
      const target = (id: string, engagementId: string, raw: string, kind: string) => ({
        id,
        engagementId,
        raw,
        normalized: raw,
        kind,
        scopeState: "unknown",
        notes: "",
        demo: false,
        createdAt: now - 2 * DAY,
        updatedAt: now - 2 * DAY,
      });
      set("targets", [
        target("t1", "e-web", "portal.example.com", "hostname"),
        target("t2", "e-web", "api.example.com", "hostname"),
        target("t3", "e-host", "10.0.5.12", "ip"),
        target("t4", "e-host", "203.0.113.40", "ip"),
      ]);
      const finding = (id: string, engagementId: string, title: string, severity: string, status: string) => ({
        id,
        engagementId,
        title,
        description: "",
        severity,
        confidence: "medium",
        status,
        affectedTargets: [],
        affectedAssets: [],
        sourceTool: "manual",
        ruleId: "",
        location: "",
        fingerprint: "fp-" + id,
        firstSeen: now - DAY,
        lastSeen: now - DAY,
        cvssVector: "",
        cvssVersion: "",
        cwe: [],
        cve: [],
        attack: [],
        reproduction: "",
        impact: "",
        remediation: "",
        references: [],
        evidenceIds: [],
        assignee: "",
        tags: [],
        falsePositiveReason: "",
        importBatchId: "",
        parserVersion: "",
        history: [],
        demo: false,
        createdAt: now - DAY,
        updatedAt: now - DAY,
      });
      set("findings", [
        finding("f1", "e-web", "Yönetim paneli kimlik doğrulamasız açık", "critical", "new"),
        finding("f2", "e-web", "Süresi dolmuş TLS sertifikası", "high", "confirmed"),
        finding("f3", "e-web", "Dizin listeleme açık", "medium", "new"),
        finding("f4", "e-file", "Paketlenmiş yürütülebilir dosya", "high", "new"),
        finding("f5", "e-disk", "Silinmiş tarayıcı geçmişi", "low", "verified"),
        finding("f6", "e-disk", "USB bağlantı izleri", "low", "mitigated"),
      ]);
      set("workspaces", [
        {
          id: "ws1",
          name: "Qutra Labs Desktop",
          color: "teal",
          icon: "folder",
          purpose: "",
          type: "software",
          status: "active",
          favorite: false,
          tags: [],
          defaultCommands: [],
          environmentLabels: [],
          ignoredPaths: [],
          browserCollections: [],
          restoreBehavior: "ask",
          health: "ready",
          createdAt: now - 10 * DAY,
          updatedAt: now - 3 * HOUR,
          lastActivityAt: now - 3 * HOUR,
        },
      ]);
    },
    { empty, MIN, HOUR, DAY },
  );
}
