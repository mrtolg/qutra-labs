import type { Database } from "@/lib/db/database";
import type {
  ActivityEvent,
  Automation,
  AutomationRun,
  ExclusionRule,
  PermissionGrant,
  Resource,
  RestoreRun,
  Session,
  Snapshot,
  Task,
  Workspace,
} from "./types";

/* ============================================================
   Realistic, internally consistent demo data.
   Every record carries demo:true so it can be removed cleanly.
   Timestamps are generated relative to "now" so screens always
   show meaningful recency.
   ============================================================ */

const NOW = () => Date.now();
const daysAgo = (d: number, hour = 10, min = 0) => {
  const t = new Date(NOW() - d * 86_400_000);
  t.setHours(hour, min, 0, 0);
  return t.getTime();
};
const hoursAgo = (h: number) => NOW() - h * 3_600_000;

export const DEMO_IDS = {
  wsDesktop: "ws_demo_desktop",
  wsCourse: "ws_demo_course",
  wsPortfolio: "ws_demo_portfolio",
};

export function isSeeded(db: Database): boolean {
  return db.collection("workspaces").getAll().some((w) => w.demo);
}

export function loadDemoData(db: Database): void {
  const now = NOW();

  /* ---------- Workspaces ---------- */
  const workspaces: Workspace[] = [
    {
      id: DEMO_IDS.wsDesktop,
      name: "Qutra Labs Desktop",
      color: "oklch(0.45 0.15 330)",
      icon: "monitor",
      purpose: "Tauri 2 + React desktop app — ship the restore center MVP",
      type: "software",
      status: "active",
      favorite: true,
      tags: ["tauri", "react", "typescript"],
      localPath: "C:\\Dev\\contextos",
      git: {
        connected: true,
        branch: "feature/restore-center",
        dirtyFiles: 7,
        ahead: 2,
        behind: 0,
        lastCommits: [
          {
            hash: "e4a91c2",
            message: "restore: per-item progress states and cancel",
            author: "dev",
            at: hoursAgo(20),
            additions: 214,
            deletions: 48,
          },
          {
            hash: "b7f30aa",
            message: "bridge: capability detection for window metadata",
            author: "dev",
            at: daysAgo(1, 16, 40),
            additions: 96,
            deletions: 12,
          },
          {
            hash: "91d2c7e",
            message: "fix: snapshot item dedupe on capture review",
            author: "dev",
            at: daysAgo(2, 11, 5),
            additions: 33,
            deletions: 21,
          },
        ],
      },
      defaultCommands: ["npm run dev", "npm run tauri dev"],
      environmentLabels: ["node 22", "rust 1.79"],
      ignoredPaths: ["node_modules", "src-tauri/target"],
      browserCollections: ["Tauri docs", "WCAG references"],
      restoreBehavior: "ask",
      health: "ready",
      resumeSnapshotId: "snap_demo_1",
      demo: true,
      createdAt: daysAgo(24),
      updatedAt: hoursAgo(19),
      lastActivityAt: hoursAgo(19),
    },
    {
      id: DEMO_IDS.wsCourse,
      name: "Distributed Systems Course",
      color: "oklch(0.55 0.11 190)",
      icon: "graduation-cap",
      purpose: "CS-4530 ders notları, okumalar ve dönem projesi hazırlığı",
      type: "research",
      status: "active",
      favorite: false,
      tags: ["ders", "raft", "okuma"],
      localPath: "C:\\Users\\dev\\Documents\\CS4530",
      git: undefined,
      defaultCommands: [],
      environmentLabels: [],
      ignoredPaths: [],
      browserCollections: ["Raft papers", "Lecture slides"],
      restoreBehavior: "restore_all",
      health: "needs_handoff",
      resumeSnapshotId: undefined,
      demo: true,
      createdAt: daysAgo(19),
      updatedAt: daysAgo(2, 21, 15),
      lastActivityAt: daysAgo(2, 21, 15),
    },
    {
      id: DEMO_IDS.wsPortfolio,
      name: "Portfolio Refresh",
      color: "oklch(0.55 0.12 85)",
      icon: "palette",
      purpose: "Kişisel site yenileme — içerik, vaka çalışmaları, yayın",
      type: "design",
      status: "paused",
      favorite: false,
      tags: ["design", "content"],
      localPath: "C:\\Dev\\portfolio",
      git: {
        connected: true,
        branch: "main",
        dirtyFiles: 0,
        ahead: 0,
        behind: 3,
        lastCommits: [
          {
            hash: "a10be77",
            message: "content: draft case study for inventory app",
            author: "dev",
            at: daysAgo(12, 22, 10),
            additions: 187,
            deletions: 9,
          },
        ],
      },
      defaultCommands: ["npm run dev"],
      environmentLabels: ["astro"],
      ignoredPaths: ["node_modules", "dist"],
      browserCollections: ["Design inspiration"],
      restoreBehavior: "ask",
      health: "missing_folder",
      resumeSnapshotId: undefined,
      demo: true,
      createdAt: daysAgo(40),
      updatedAt: daysAgo(11),
      lastActivityAt: daysAgo(11),
    },
  ];

  /* ---------- Sessions ---------- */
  const sessions: Session[] = [
    {
      id: "sess_demo_1",
      workspaceId: DEMO_IDS.wsDesktop,
      title: "Restore center: per-item states",
      intendedOutcome: "Restore rows show queued→launching→restored with cancel working",
      status: "completed",
      startedAt: hoursAgo(23),
      endedAt: hoursAgo(19),
      pausedTotalMs: 15 * 60_000,
      plannedMinutes: 180,
      linkedTaskIds: ["task_demo_1", "task_demo_2"],
      resourceIds: ["res_demo_1"],
      distractionTracking: true,
      autoSnapshot: "on_end",
      interruptions: [
        {
          id: "int_demo_1",
          at: hoursAgo(21),
          reason: "Kargo teslimatı",
          minutes: 12,
          returnedAt: hoursAgo(21) + 12 * 60_000,
        },
      ],
      review: {
        outcomeAchieved: "partial",
        completedWork:
          "State machine finished; cancel works; retry-failed pending",
        unresolved: "Elevated apps still fail silently on reposition",
        learned: "Win32 SetWindowPos needs the app to be DPI-aware",
        nextAction: "Implement retry-failed and elevation warning row",
        snapshotId: "snap_demo_1",
      },
      demo: true,
      createdAt: hoursAgo(23),
      updatedAt: hoursAgo(19),
    },
    {
      id: "sess_demo_2",
      workspaceId: DEMO_IDS.wsCourse,
      title: "Raft okuması: bölüm 5-6",
      intendedOutcome: "Leader election notlarını bitir, quiz sorularını çıkar",
      status: "completed",
      startedAt: daysAgo(2, 19, 0),
      endedAt: daysAgo(2, 21, 15),
      pausedTotalMs: 0,
      plannedMinutes: 120,
      linkedTaskIds: ["task_demo_6"],
      resourceIds: ["res_demo_4"],
      distractionTracking: false,
      autoSnapshot: "off",
      interruptions: [],
      review: {
        outcomeAchieved: "yes",
        completedWork: "Bölüm 5 tamam, log replication özetlendi",
        unresolved: "Snapshot/InstallSnapshot RPC hâlâ bulanık",
        learned: "Commit index yalnızca çoğunluk onayı ile ilerler",
        nextAction: "Bölüm 7'yi oku, örnek senaryo çiz",
      },
      demo: true,
      createdAt: daysAgo(2, 19, 0),
      updatedAt: daysAgo(2, 21, 15),
    },
    {
      id: "sess_demo_3",
      workspaceId: DEMO_IDS.wsDesktop,
      title: "Snapshot capture review flow",
      intendedOutcome: "Capture dialog lists apps/tabs/git with deselect",
      status: "completed",
      startedAt: daysAgo(3, 9, 30),
      endedAt: daysAgo(3, 12, 45),
      pausedTotalMs: 0,
      plannedMinutes: 150,
      linkedTaskIds: ["task_demo_3"],
      resourceIds: [],
      distractionTracking: true,
      autoSnapshot: "on_end",
      interruptions: [
        {
          id: "int_demo_2",
          at: daysAgo(3, 10, 40),
          reason: "Slack: prod alarmı (yanlış alarm)",
          minutes: 25,
          returnedAt: daysAgo(3, 11, 5),
        },
        {
          id: "int_demo_3",
          at: daysAgo(3, 12, 0),
          reason: "Telefon: banka araması",
          minutes: 8,
          returnedAt: daysAgo(3, 12, 8),
        },
      ],
      review: {
        outcomeAchieved: "yes",
        completedWork: "Review flow with sensitive-item deselect shipped",
        unresolved: "",
        learned: "Users need excluded apps listed, not hidden",
        nextAction: "Wire capture into session end review",
      },
      demo: true,
      createdAt: daysAgo(3, 9, 30),
      updatedAt: daysAgo(3, 12, 45),
    },
    {
      id: "sess_demo_4",
      workspaceId: DEMO_IDS.wsPortfolio,
      title: "Vaka çalışması taslağı",
      intendedOutcome: "Envanter uygulaması vaka metni ilk taslak",
      status: "completed",
      startedAt: daysAgo(12, 20, 0),
      endedAt: daysAgo(12, 22, 30),
      pausedTotalMs: 0,
      plannedMinutes: 120,
      linkedTaskIds: ["task_demo_8"],
      resourceIds: ["res_demo_6"],
      distractionTracking: false,
      autoSnapshot: "off",
      interruptions: [],
      review: {
        outcomeAchieved: "partial",
        completedWork: "Giriş + problem bölümü yazıldı",
        unresolved: "Görseller seçilmedi",
        learned: "",
        nextAction: "Ekran görüntülerini topla, metni bitir",
      },
      demo: true,
      createdAt: daysAgo(12, 20, 0),
      updatedAt: daysAgo(12, 22, 30),
    },
    {
      id: "sess_demo_5",
      workspaceId: DEMO_IDS.wsDesktop,
      title: "Bridge capability detection",
      intendedOutcome: "UI never claims native success in browser mode",
      status: "completed",
      startedAt: daysAgo(1, 14, 0),
      endedAt: daysAgo(1, 17, 20),
      pausedTotalMs: 10 * 60_000,
      plannedMinutes: 180,
      linkedTaskIds: ["task_demo_2"],
      resourceIds: ["res_demo_2"],
      distractionTracking: true,
      autoSnapshot: "on_end",
      interruptions: [
        {
          id: "int_demo_4",
          at: daysAgo(1, 15, 30),
          reason: "Slack: prod alarmı (yanlış alarm)",
          minutes: 18,
          returnedAt: daysAgo(1, 15, 48),
        },
      ],
      review: {
        outcomeAchieved: "yes",
        completedWork: "Capability struct + simulated flags everywhere",
        unresolved: "Stronghold integration blocked on plugin update",
        learned: "Honest 'simulated' labels build more trust than fake green",
        nextAction: "Restore center retry + elevation warnings",
      },
      demo: true,
      createdAt: daysAgo(1, 14, 0),
      updatedAt: daysAgo(1, 17, 20),
    },
  ];

  /* ---------- Snapshots ---------- */
  const snapshots: Snapshot[] = [
    {
      id: "snap_demo_1",
      workspaceId: DEMO_IDS.wsDesktop,
      sessionId: "sess_demo_1",
      name: "Restore center WIP — end of day",
      handoff:
        "Retry-failed kaldı. Elevation uyarı satırı için RestoreItemResult.reason kullan. Test: npm run test restore.",
      items: [
        {
          id: "si_demo_1",
          kind: "app",
          title: "Visual Studio Code",
          detail: "contextos — src/features/restore",
          target: "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
          windowBounds: { monitor: 0, x: 0, y: 0, w: 1280, h: 1040 },
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_2",
          kind: "terminal",
          title: "Windows Terminal — PowerShell",
          detail: "cwd: C:\\Dev\\contextos · last: npm run dev",
          target: "wt.exe",
          windowBounds: { monitor: 1, x: 1920, y: 60, w: 960, h: 640 },
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_3",
          kind: "browser_tab",
          title: "Tauri 2 window API",
          detail: "tauri.app",
          target: "https://v2.tauri.app/reference/javascript/api/namespacewindow/",
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_4",
          kind: "browser_tab",
          title: "PowerToys Workspaces docs",
          detail: "learn.microsoft.com",
          target: "https://learn.microsoft.com/en-us/windows/powertoys/workspaces",
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_5",
          kind: "git",
          title: "feature/restore-center",
          detail: "7 changed · 2 ahead · last: e4a91c2",
          target: "C:\\Dev\\contextos",
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_6",
          kind: "app",
          title: "DB Browser (admin)",
          detail: "requires admin elevation",
          target: "C:\\Program Files\\DB Browser\\elevated.exe",
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_7",
          kind: "file",
          title: "restore-plan.md",
          detail: "C:\\Dev\\contextos\\docs",
          target: "C:\\Dev\\contextos\\docs\\restore-plan.md",
          selected: true,
          sensitive: false,
        },
      ],
      monitors: [
        { index: 0, width: 1920, height: 1080, scale: 1.25 },
        { index: 1, width: 2560, height: 1440, scale: 1 },
      ],
      appVersion: "0.1.0",
      demo: true,
      createdAt: hoursAgo(19),
    },
    {
      id: "snap_demo_2",
      workspaceId: DEMO_IDS.wsDesktop,
      sessionId: "sess_demo_3",
      name: "Capture flow shipped",
      handoff: "Capture review tamam. Sıradaki: session-end entegrasyonu.",
      items: [
        {
          id: "si_demo_8",
          kind: "app",
          title: "Visual Studio Code",
          detail: "contextos — src/features/snapshots",
          target: "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
          windowBounds: { monitor: 0, x: 0, y: 0, w: 1280, h: 1040 },
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_9",
          kind: "browser_tab",
          title: "WCAG 2.2 quickref",
          detail: "w3.org",
          target: "https://www.w3.org/WAI/WCAG22/quickref/",
          selected: true,
          sensitive: false,
        },
      ],
      monitors: [{ index: 0, width: 1920, height: 1080, scale: 1.25 }],
      appVersion: "0.1.0",
      demo: true,
      createdAt: daysAgo(3, 12, 45),
    },
    {
      id: "snap_demo_3",
      workspaceId: DEMO_IDS.wsCourse,
      sessionId: "sess_demo_2",
      name: "Raft çalışması — hafta 6",
      handoff: "Bölüm 7'den devam. Quiz soruları notlarda.",
      items: [
        {
          id: "si_demo_10",
          kind: "browser_tab",
          title: "In Search of an Understandable Consensus Algorithm",
          detail: "raft.github.io",
          target: "https://raft.github.io/raft.pdf",
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_11",
          kind: "app",
          title: "Visual Studio Code",
          detail: "Raft workspace",
          target: "C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
          selected: true,
          sensitive: false,
        },
        {
          id: "si_demo_12",
          kind: "file",
          title: "raft-notes.md",
          detail: "missing after vault reorg",
          target: "C:\\Users\\dev\\Documents\\CS4530\\missing\\raft-notes.md",
          selected: true,
          sensitive: false,
        },
      ],
      monitors: [{ index: 0, width: 1920, height: 1080, scale: 1.25 }],
      appVersion: "0.1.0",
      demo: true,
      createdAt: daysAgo(2, 21, 15),
    },
  ];

  /* ---------- Restore runs (one with a failed item) ---------- */
  const restoreRuns: RestoreRun[] = [
    {
      id: "rr_demo_1",
      snapshotId: "snap_demo_2",
      workspaceId: DEMO_IDS.wsDesktop,
      startedAt: daysAgo(2, 9, 5),
      finishedAt: daysAgo(2, 9, 7),
      status: "partial",
      simulated: true,
      items: [
        { itemId: "si_demo_8", state: "restored", finishedAt: daysAgo(2, 9, 6) },
        {
          itemId: "si_demo_9",
          state: "failed",
          reason: "timeout",
          finishedAt: daysAgo(2, 9, 7),
        },
      ],
      demo: true,
    },
  ];

  /* ---------- Tasks ---------- */
  const tasks: Task[] = [
    {
      id: "task_demo_1",
      title: "Restore: retry-failed action",
      description: "Only failed/permission rows re-queue; keep completed states.",
      workspaceId: DEMO_IDS.wsDesktop,
      status: "in_progress",
      priority: "high",
      dueAt: daysAgo(-1, 18),
      estimateMinutes: 120,
      tags: ["restore"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      evidence: { sessionId: "sess_demo_1" },
      demo: true,
      createdAt: daysAgo(4),
      updatedAt: hoursAgo(19),
    },
    {
      id: "task_demo_2",
      title: "Elevation warning row in restore plan",
      description: "Show 'requires administrator elevation' before launch.",
      workspaceId: DEMO_IDS.wsDesktop,
      status: "todo",
      priority: "medium",
      dueAt: daysAgo(-2, 18),
      estimateMinutes: 60,
      tags: ["restore", "windows"],
      parentId: undefined,
      blockedByIds: ["task_demo_1"],
      recurrence: "none",
      carriedOverCount: 1,
      demo: true,
      createdAt: daysAgo(4),
      updatedAt: daysAgo(1),
    },
    {
      id: "task_demo_3",
      title: "Snapshot capture review flow",
      description: "",
      workspaceId: DEMO_IDS.wsDesktop,
      status: "done",
      priority: "high",
      dueAt: undefined,
      estimateMinutes: 180,
      tags: ["snapshots"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      evidence: { sessionId: "sess_demo_3", commitHash: "91d2c7e" },
      demo: true,
      createdAt: daysAgo(6),
      updatedAt: daysAgo(3, 12, 45),
      completedAt: daysAgo(3, 12, 45),
    },
    {
      id: "task_demo_4",
      title: "Stronghold: move AI key storage",
      description: "Blocked: waiting for plugin 2.x fix.",
      workspaceId: DEMO_IDS.wsDesktop,
      status: "backlog",
      priority: "medium",
      dueAt: undefined,
      estimateMinutes: 90,
      tags: ["security"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 3,
      demo: true,
      createdAt: daysAgo(15),
      updatedAt: daysAgo(5),
    },
    {
      id: "task_demo_5",
      title: "Write ADR: desktop bridge boundary",
      description: "",
      workspaceId: DEMO_IDS.wsDesktop,
      status: "todo",
      priority: "low",
      dueAt: daysAgo(0, 17),
      estimateMinutes: 45,
      tags: ["docs"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: true,
      createdAt: daysAgo(2),
      updatedAt: daysAgo(2),
    },
    {
      id: "task_demo_6",
      title: "Raft bölüm 7 oku + senaryo çiz",
      description: "InstallSnapshot RPC akışını örnekle.",
      workspaceId: DEMO_IDS.wsCourse,
      status: "todo",
      priority: "high",
      dueAt: daysAgo(-1, 20),
      estimateMinutes: 90,
      tags: ["okuma"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      demo: true,
      createdAt: daysAgo(2, 21, 20),
      updatedAt: daysAgo(2, 21, 20),
    },
    {
      id: "task_demo_7",
      title: "Quiz hazırlığı: leader election soruları",
      description: "",
      workspaceId: DEMO_IDS.wsCourse,
      status: "done",
      priority: "medium",
      dueAt: daysAgo(2, 20),
      estimateMinutes: 45,
      tags: ["quiz"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      evidence: { sessionId: "sess_demo_2" },
      demo: true,
      createdAt: daysAgo(5),
      updatedAt: daysAgo(2, 21, 0),
      completedAt: daysAgo(2, 21, 0),
    },
    {
      id: "task_demo_8",
      title: "Vaka çalışması: ekran görüntülerini topla",
      description: "Stale: 12 gündür bekliyor.",
      workspaceId: DEMO_IDS.wsPortfolio,
      status: "todo",
      priority: "medium",
      dueAt: daysAgo(9, 18),
      estimateMinutes: 60,
      tags: ["içerik"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 4,
      demo: true,
      createdAt: daysAgo(13),
      updatedAt: daysAgo(12),
    },
    {
      id: "task_demo_9",
      title: "Haftalık gözden geçirme",
      description: "Açık görevleri ve devir notlarını tara.",
      workspaceId: undefined,
      status: "todo",
      priority: "none",
      dueAt: daysAgo(-3, 9),
      estimateMinutes: 30,
      tags: ["rutin"],
      parentId: undefined,
      blockedByIds: [],
      recurrence: "weekly",
      carriedOverCount: 0,
      demo: true,
      createdAt: daysAgo(7),
      updatedAt: daysAgo(7),
    },
    {
      id: "task_demo_10",
      title: "Restore: copy launch command action",
      description: "",
      workspaceId: DEMO_IDS.wsDesktop,
      status: "done",
      priority: "low",
      dueAt: undefined,
      estimateMinutes: 30,
      tags: ["restore"],
      parentId: "task_demo_1",
      blockedByIds: [],
      recurrence: "none",
      carriedOverCount: 0,
      evidence: { commitHash: "e4a91c2" },
      demo: true,
      createdAt: daysAgo(3),
      updatedAt: hoursAgo(21),
      completedAt: hoursAgo(21),
    },
  ];

  /* ---------- Resources ---------- */
  const resources: Resource[] = [
    {
      id: "res_demo_1",
      kind: "url",
      title: "Tauri 2 window API",
      target: "https://v2.tauri.app/reference/javascript/api/namespacewindow/",
      workspaceId: DEMO_IDS.wsDesktop,
      tags: ["docs"],
      lastOpenedAt: hoursAgo(20),
      demo: true,
      createdAt: daysAgo(10),
    },
    {
      id: "res_demo_2",
      kind: "url",
      title: "Tauri security model",
      target: "https://v2.tauri.app/security/",
      workspaceId: DEMO_IDS.wsDesktop,
      tags: ["docs", "security"],
      lastOpenedAt: daysAgo(1, 15, 0),
      demo: true,
      createdAt: daysAgo(10),
    },
    {
      id: "res_demo_3",
      kind: "folder",
      title: "contextos repo",
      target: "C:\\Dev\\contextos",
      workspaceId: DEMO_IDS.wsDesktop,
      tags: [],
      lastOpenedAt: hoursAgo(19),
      demo: true,
      createdAt: daysAgo(24),
    },
    {
      id: "res_demo_4",
      kind: "url",
      title: "Raft paper (PDF)",
      target: "https://raft.github.io/raft.pdf",
      workspaceId: DEMO_IDS.wsCourse,
      tags: ["okuma"],
      lastOpenedAt: daysAgo(2, 19, 5),
      demo: true,
      createdAt: daysAgo(18),
    },
    {
      id: "res_demo_5",
      kind: "url",
      title: "MIT 6.824 ders programı",
      target: "https://pdos.csail.mit.edu/6.824/",
      workspaceId: DEMO_IDS.wsCourse,
      tags: [],
      lastOpenedAt: daysAgo(6),
      demo: true,
      createdAt: daysAgo(18),
    },
    {
      id: "res_demo_6",
      kind: "url",
      title: "Envanter uygulaması — canlı demo",
      target: "https://example-inventory.pages.dev",
      workspaceId: DEMO_IDS.wsPortfolio,
      tags: ["vaka"],
      lastOpenedAt: daysAgo(12, 21, 0),
      demo: true,
      createdAt: daysAgo(14),
    },
  ];

  /* ---------- Automations ---------- */
  const automations: Automation[] = [
    {
      id: "auto_demo_1",
      name: "Session sonunda snapshot hatırlat",
      trigger: "session_ended",
      conditions: [{ field: "workspace", value: DEMO_IDS.wsDesktop }],
      actions: [
        { type: "notify", param: "Snapshot almayı unutma" },
        { type: "create_task", param: "Devir notunu tamamla" },
      ],
      enabled: true,
      requiresConfirmation: false,
      rateLimitPerHour: 4,
      retryPolicy: "none",
      lastRunAt: hoursAgo(19),
      nextRunAt: undefined,
      demo: true,
      createdAt: daysAgo(8),
      updatedAt: hoursAgo(19),
    },
    {
      id: "auto_demo_2",
      name: "Pazartesi 09:00 haftalık plan notu",
      trigger: "schedule",
      conditions: [{ field: "day", value: "1" }],
      actions: [{ type: "create_task", param: "daily" }],
      enabled: true,
      requiresConfirmation: false,
      rateLimitPerHour: 1,
      retryPolicy: "once",
      lastRunAt: daysAgo(2, 9, 0),
      nextRunAt: daysAgo(-5, 9, 0),
      demo: true,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(2, 9, 0),
    },
    {
      id: "auto_demo_3",
      name: "Portfolio açılınca ilham koleksiyonunu aç",
      trigger: "workspace_opened",
      conditions: [{ field: "workspace", value: DEMO_IDS.wsPortfolio }],
      actions: [{ type: "open_resource", param: "res_demo_6" }],
      enabled: false,
      requiresConfirmation: false,
      rateLimitPerHour: 6,
      retryPolicy: "none",
      lastRunAt: daysAgo(12, 20, 0),
      nextRunAt: undefined,
      demo: true,
      createdAt: daysAgo(25),
      updatedAt: daysAgo(11),
    },
  ];

  const automationRuns: AutomationRun[] = [
    {
      id: "ar_demo_1",
      automationId: "auto_demo_1",
      at: hoursAgo(19),
      status: "success",
      detail: "notify ✓ · create_task ✓ (Devir notunu tamamla)",
      demo: true,
    },
    {
      id: "ar_demo_2",
      automationId: "auto_demo_2",
      at: daysAgo(2, 9, 0),
      status: "success",
      detail: "create_note ✓ (Günlük not)",
      demo: true,
    },
    {
      id: "ar_demo_3",
      automationId: "auto_demo_1",
      at: daysAgo(3, 12, 45),
      status: "success",
      detail: "notify ✓ · create_task ✓",
      demo: true,
    },
    {
      id: "ar_demo_4",
      automationId: "auto_demo_3",
      at: daysAgo(12, 20, 0),
      status: "failed",
      detail: "open_resource ✗ — kaynak taşınmış (res_demo_6)",
      demo: true,
    },
  ];

  /* ---------- Exclusions & permissions ---------- */
  const exclusions: ExclusionRule[] = [
    {
      id: "exc_demo_1",
      kind: "app",
      value: "1Password",
      note: "Parola yöneticisi — önerilen",
      demo: true,
      createdAt: daysAgo(24),
    },
    {
      id: "exc_demo_2",
      kind: "app",
      value: "KeePassXC",
      note: "Parola yöneticisi — önerilen",
      demo: true,
      createdAt: daysAgo(24),
    },
    {
      id: "exc_demo_3",
      kind: "domain",
      value: "bank",
      note: "Bankacılık sekmeleri asla yakalanmaz",
      demo: true,
      createdAt: daysAgo(20),
    },
    {
      id: "exc_demo_4",
      kind: "path",
      value: "C:\\Users\\dev\\Documents\\personal",
      note: "",
      demo: true,
      createdAt: daysAgo(20),
    },
  ];

  const permissions: PermissionGrant[] = [
    { id: "file_access", key: "file_access", state: "granted", updatedAt: daysAgo(24) },
    { id: "git_inspection", key: "git_inspection", state: "granted", updatedAt: daysAgo(24) },
    { id: "window_metadata", key: "window_metadata", state: "granted", updatedAt: daysAgo(24) },
    { id: "global_shortcuts", key: "global_shortcuts", state: "granted", updatedAt: daysAgo(24) },
    { id: "notifications", key: "notifications", state: "granted", updatedAt: daysAgo(24) },
    { id: "browser_integration", key: "browser_integration", state: "denied", updatedAt: daysAgo(10) },
    { id: "ai_provider", key: "ai_provider", state: "not_asked", updatedAt: daysAgo(24) },
  ];

  /* ---------- Activity events (several weeks) ---------- */
  const events: ActivityEvent[] = [];
  let evi = 0;
  const push = (e: Omit<ActivityEvent, "id" | "demo">) => {
    events.push({ ...e, id: `ev_demo_${evi++}`, demo: true });
  };

  // Sessions → events
  for (const s of sessions) {
    if (s.startedAt) {
      push({
        type: "workspace_opened",
        at: s.startedAt - 4 * 60_000,
        workspaceId: s.workspaceId,
        refId: s.workspaceId,
        label: "Workspace opened",
        detail: "",
        minutes: 0,
      });
      push({
        type: "session_started",
        at: s.startedAt,
        workspaceId: s.workspaceId,
        refId: s.id,
        label: s.title,
        detail: s.intendedOutcome,
        minutes: 0,
      });
    }
    if (s.endedAt && s.startedAt) {
      push({
        type: "session_ended",
        at: s.endedAt,
        workspaceId: s.workspaceId,
        refId: s.id,
        label: s.title,
        detail: s.review?.completedWork ?? "",
        minutes: Math.round((s.endedAt - s.startedAt - s.pausedTotalMs) / 60_000),
      });
    }
  }
  // Snapshots
  for (const sn of snapshots) {
    push({
      type: "snapshot_saved",
      at: sn.createdAt,
      workspaceId: sn.workspaceId,
      refId: sn.id,
      label: sn.name,
      detail: `${sn.items.length} items`,
      minutes: 0,
    });
  }
  // Restore
  push({
    type: "restore_run",
    at: daysAgo(2, 9, 5),
    workspaceId: DEMO_IDS.wsDesktop,
    refId: "rr_demo_1",
    label: "Capture flow shipped",
    detail: "partial · 1 failed (timeout)",
    minutes: 0,
  });
  // Tasks
  for (const t of tasks) {
    if (t.completedAt) {
      push({
        type: "task_completed",
        at: t.completedAt,
        workspaceId: t.workspaceId,
        refId: t.id,
        label: t.title,
        detail: "",
        minutes: 0,
      });
    }
  }
  // Commits
  for (const w of workspaces) {
    for (const c of w.git?.lastCommits ?? []) {
      push({
        type: "commit",
        at: c.at,
        workspaceId: w.id,
        refId: c.hash,
        label: c.message,
        detail: `${c.hash} · +${c.additions} −${c.deletions}`,
        minutes: 0,
      });
    }
  }
  // Notes / decisions
  push({
    type: "decision_recorded",
    at: daysAgo(5, 15, 0),
    workspaceId: DEMO_IDS.wsDesktop,
    refId: "note_demo_3",
    label: "Snapshots store window bounds per monitor",
    detail: "",
    minutes: 0,
  });
  // Automations
  for (const ar of automationRuns) {
    const auto = automations.find((a) => a.id === ar.automationId);
    push({
      type: "automation_run",
      at: ar.at,
      workspaceId: auto?.conditions.find((c) => c.field === "workspace")?.value,
      refId: ar.id,
      label: auto?.name ?? "Automation",
      detail: ar.status,
      minutes: 0,
    });
  }
  // Privacy events
  push({
    type: "privacy_paused",
    at: daysAgo(6, 13, 0),
    label: "Clipboard capture paused (1 hour)",
    detail: "",
    minutes: 0,
  });
  push({
    type: "privacy_resumed",
    at: daysAgo(6, 14, 0),
    label: "Clipboard capture resumed",
    detail: "",
    minutes: 0,
  });
  push({
    type: "permission_changed",
    at: daysAgo(10, 9, 30),
    label: "Browser integration denied",
    detail: "",
    minutes: 0,
  });
  // Background app activity to make collapsing meaningful (varied by weekday)
  for (let d = 0; d < 21; d++) {
    if (d % 7 === 5 || d % 7 === 6) continue; // quieter weekends
    const wsId = d % 3 === 0 ? DEMO_IDS.wsCourse : DEMO_IDS.wsDesktop;
    const appCount = 2 + ((d * 7) % 4);
    for (let k = 0; k < appCount; k++) {
      push({
        type: "app_activity",
        at: daysAgo(d, 9 + k * 2, (d * 13 + k * 17) % 60),
        workspaceId: wsId,
        label: k % 2 === 0 ? "Visual Studio Code" : "Firefox",
        detail: "focused window",
        minutes: 15 + ((d + k) % 4) * 10,
      });
    }
  }

  /* ---------- Write everything ---------- */
  db.collection("workspaces").bulkPut(workspaces);
  db.collection("sessions").bulkPut(sessions);
  db.collection("snapshots").bulkPut(snapshots);
  db.collection("restoreRuns").bulkPut(restoreRuns);
  db.collection("tasks").bulkPut(tasks);
  db.collection("resources").bulkPut(resources);
  db.collection("automations").bulkPut(automations);
  db.collection("automationRuns").bulkPut(automationRuns);
  db.collection("exclusions").bulkPut(exclusions);
  db.collection("permissions").bulkPut(permissions);
  db.collection("events").bulkPut(events);

  // Suppress unused variable — `now` documents intent above.
  void now;
}
