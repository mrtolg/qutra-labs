# Product

## Register

product

## Platform

windows-desktop

Qutra Labs ships as a Windows-first Tauri 2 desktop application with a native
window, SQLite persistence and narrow Rust integrations. The Vite build exists
for development and automated verification; it is not the delivered product.

## Users

Qutra Labs is a local operations workbench for an individual developer and
authorized security practitioner. It keeps project state, local files, approved
tools, terminal diagnostics, Git activity and security-lab evidence in one
inspectable desktop environment.

## Product Purpose

The product reduces the time required to resume a technical project and provides
a controlled place to register, verify, run and audit local tools. Native actions
must be real, permission-bounded and visibly distinguishable from browser-mode
fixtures.

## Product Surface

The product has exactly nine top-level modules:

1. Overview
2. Projects
3. Files
4. Tools
5. Security Lab
6. Terminal
7. GitHub
8. Assistant
9. System

Sessions, tasks, snapshots, resources, activity, findings, evidence, runs,
methodology and tool guides are contextual views inside those modules. They are
not separate product-level destinations.

## Brand Personality

Focused, capable and quietly distinctive. The interface is a precise personal
control room: information-rich without noise, technically serious without
becoming sterile.

## Design Principles

- Context before chronology.
- Resume and inspect are primary actions.
- Local trust, authorization and tool identity are visible.
- Dense but calm layouts support repeated technical work.
- Every control performs a real action or clearly reports why it cannot.
- No invented native success, placeholder metrics or decorative dashboards.

## Accessibility

Target WCAG 2.2 AA. All core workflows must be keyboard-operable with visible
focus, logical focus order, screen-reader status announcements, non-color state
cues, reduced-motion support and zoom/reflow resilience.

## Current Scope

- Persistent workbench tabs and command palette.
- Project sessions, tasks, snapshots, resources and activity.
- Local file/resource inventory and terminal/debugging surfaces.
- Verified local-tool registry and Windows native supervisor.
- Authorization-first Security Lab with scope, targets, runs, findings,
  evidence, parsers and safe tool guides.
- Optional read-only GitHub integration.
- Local assistant surface with explicit provider boundaries.
- Six UI locales and semantic theme system.
- Versioned local-data migration, export and deletion.
