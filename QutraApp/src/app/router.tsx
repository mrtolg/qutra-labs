import { lazy } from "react";
import { withDeferredCopy } from "@/lib/i18n";
import {
  createHashRouter,
  Navigate,
} from "react-router-dom";
import { AppShell } from "./AppShell";
import { Load } from "./Load";
import { RequireOnboarding } from "./RequireOnboarding";

/* Heavy routes are lazy-loaded to keep first paint fast. */
const OverviewPage = lazy(withDeferredCopy(() => import("@/features/overview/OverviewPage")));
const WorkspacesPage = lazy(withDeferredCopy(() => import("@/features/workspaces/WorkspacesPage")));
const WorkspaceDetailPage = lazy(withDeferredCopy(() => import("@/features/workspaces/WorkspaceDetailPage")));
const FocusPage = lazy(withDeferredCopy(() => import("@/features/sessions/FocusPage")));
const FilesPage = lazy(withDeferredCopy(() => import("@/features/files/FilesPage")));
const GitHubPage = lazy(withDeferredCopy(() => import("@/features/github/GitHubPage")));
const ToolsPage = lazy(withDeferredCopy(() => import("@/features/tools/ToolsPage")));
const LabPage = lazy(withDeferredCopy(() => import("@/features/lab/LabPage")));
const OnboardingPage = lazy(withDeferredCopy(() => import("@/features/onboarding/OnboardingPage")));
const NotFoundPage = lazy(withDeferredCopy(() => import("@/features/notfound/NotFoundPage")));

export const router = createHashRouter([
  {
    path: "/onboarding",
    element: (
      <Load>
        <OnboardingPage />
      </Load>
    ),
  },
  {
    path: "/",
    element: (
      <RequireOnboarding>
        <AppShell />
      </RequireOnboarding>
    ),
    children: [
      { index: true, element: <Navigate to="/overview" replace /> },
      { path: "overview", element: <Load><OverviewPage /></Load> },
      { path: "workspaces", element: <Load><WorkspacesPage /></Load> },
      {
        path: "workspaces/:id",
        element: <Load><WorkspaceDetailPage /></Load>,
      },
      {
        path: "workspaces/:id/:tab",
        element: <Load><WorkspaceDetailPage /></Load>,
      },
      { path: "sessions/focus", element: <Load><FocusPage /></Load> },
      { path: "files", element: <Load><FilesPage /></Load> },
      { path: "terminal", element: null },
      { path: "jarvis", element: null },
      { path: "github", element: <Load><GitHubPage /></Load> },
      { path: "tools", element: <Load><ToolsPage /></Load> },
      { path: "lab", element: <Load><LabPage /></Load> },
      { path: "*", element: <Load><NotFoundPage /></Load> },
    ],
  },
]);
