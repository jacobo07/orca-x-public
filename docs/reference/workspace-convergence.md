---
covers: [global-nav, workspace-convergence, workspace-home, workspace-nav, workstation, sessions-visual, agents-conversations, visual-baseline]
status: APPROVED (Owner 2026-10-01, "y" on the inline plan)
branch: orca-x/product-convergence (Apps\orca-convergence-wt), base integration-3 9f07833ff
---

# Workspace convergence — spec of record

One Orca X shell, one global navigation, one Workspace. Workspace opens on Resume Center and projects
Resume · Agents · Threads · Projects · Backlog · Workstation from their existing owners. Nothing here
owns state; every surface is a projection.

## 1. Measured causes (integration-3 `9f07833ff`)

| Symptom | Cause |
|---|---|
| Entering Workspace shrinks the left side | Three navigation owners: the activity rail inside the side panel strip, a fallback copy (`WorkspaceActivityRailColumn`) on full-page views, and the worktree Sidebar. `conversations` unmounts the Sidebar (spec §12 C3) and suppresses the panel, leaving a bare 40 px rail — and that column returns `null` when the panel is docked right or the activity bar is on top, so global navigation vanishes entirely there. |
| Workspace does not land on Resume | The Workspace entry dispatches `openConversationsPage`; Resume Center is reachable only by a History icon in the roster header. |
| Mission Brief "missing" | Merged and wired into Resume Center, but rendered only after the workspace *name* (styled as plain text) is clicked; nothing is selected by default. |
| Workstation undiscoverable | No surface. Host registry/health, project host setups, host repo catalog, live sessions per host and replica topology (DWS branch) exist only inside Settings. |
| Visual drift | No shared shell primitive; each surface was built against its own mock. The registry polices only Mission Brief and the superseded shell r01/r02. |
| Naming | Rail has `agent-workspace` ("Workspace" → conversations) and `workspace` ("Terminals" → launcher). The `agents` view has no opener. |

## 2. Contract

1. **Global navigation is one component on every route** (`GlobalNavSidebar`, window's left edge,
   full height). Same items in the same order on every view. Expanded (labeled) or collapsed (icons)
   is a persisted user choice (`globalNavCollapsed`), never a route decision.
2. Items are only real destinations: Home (`terminal`), Workspace, Terminals (launcher), Tasks,
   Automations, opt-ins (Activity, Artifacts, Skills), Orca Mobile, Settings. No Knowledge / Runtime /
   Audit: nothing in Orca owns them.
3. **Workspace** = views `resumeCenter | conversations | backlog | workstation`. The global entry opens
   `resumeCenter` (the Workspace home) and is current on all four.
4. Workspace pages share `WorkspaceFrame`: breadcrumb bar, page body, and ONE right column whose top is
   the Workspace navigation (Resume · Agents · Threads · Projects · Backlog · Workstation) and whose
   remainder is the page's context. Narrow widths fold the column; the navigation becomes a strip at
   the top, never disappears.
5. Resume home auto-selects the most recent workspace so Mission Brief is visible on arrival; the
   selection has a visible affordance. Absent mission data renders the brief's own NO MISSION /
   UNKNOWN states.
6. Agents is a conversation list: agent identity + latest thread + last activity + real status. Agent,
   thread, provider and runtime identities stay distinct. Unread/attention render only from a real
   producer.
7. Workstation projects nodes from the host registry: identity, health (UNKNOWN unless observed),
   projects placed, live sessions. Only existing actions are exposed.

### 2.A Amendment — Resume Center exception (Owner ruling 2026-10-02; LIVE `1b344b550`, `fea36a47f`, `27a8e6713`)

Supersedes §2.1–§2.3 on `resumeCenter` only; every other view keeps them unchanged.

- **Its own left navigation**, following reference `resume-center.full.desktop.at-rest.r01`: still the
  one `GlobalNavSidebar` column, same position and width, with `data-global-nav-variant="resume-center"`
  (`"global"` everywhere else). Entries, in order: Back (a control, `data-global-nav-control="back"`, not
  a destination) · Home · Cognitive Workspace (current) · Projects · Agents · Tasks · Knowledge · Runtime
  · Audit · Settings.
- **Back** leaves Workspace for the view it was entered from (`closeConversationsPage`); the global
  variant returns.
- **Knowledge and Audit** have no owner in Orca (§2.2 still holds for them): shown disabled and labelled
  "Not available yet", never controls that do nothing. Tasks and Runtime keep the gating they have
  elsewhere (Tasks needs a provider; Runtime = Activity, behind `experimentalActivity`).
- **Right column** = Workspace navigation (§2.4) then the titled compact Mission Brief, then the desk
  summary.
- Labels wrap to two lines rather than truncate, so long localized names (es "Espacio de trabajo
  cognitivo") and their "not available yet" hint stay readable. Product names are translated; EN and ES
  only.

## 3. Capability inventory — activity rail → global navigation

| Capability (source) | Destination |
|---|---|
| 9 activities + visibility gates (`workspace-activity-items.ts`) | RETAINED in GlobalNav |
| Hide-from-sidebar context menu per activity | RETAINED |
| Tasks provider context menu, disabled when no repo, prefetch on hover/focus | RETAINED |
| Activity unread count, Mobile "New" dot, badge in accessible name | RETAINED (labeled mode shows the count/word) |
| Mobile badge dismissed on open | RETAINED |
| `aria-current`, `data-workspace-activity*` hooks, tooltips | RETAINED (tooltip only when collapsed) |
| Exhaustive `never` dispatch | RETAINED |
| `AgentWorkspaceRailEntry` (Workspace below Explorer) | REPLACED by GlobalNav Workspace |
| `WorkspaceActivityRailColumn` (rail on full-page views) | REPLACED — GlobalNav is always mounted |
| Rail section inside side-panel strip | RELOCATED to GlobalNav; strip keeps panel tabs + Projects switch |
| Projects switch on full-page views | REMOVED there: no worktree Sidebar is shown on those views, so it changed nothing visible |
| Windows titlebar logo / macOS traffic-light pad | RELOCATED to GlobalNav header (it now owns the window's left edge) |
| Titlebar app name + "Hide App Name" menu | RELOCATED to GlobalNav header |
| Backlog activity | RELOCATED (W2) to Workspace navigation; `showBacklogButton` then has no surface |

## 4. Acceptance

- e2e `global-nav-shell-stability`: identical `[data-global-nav-item]` id list and identical nav
  width on terminal, Workspace (every destination), Tasks, Automations, Settings. Mutation: hide one
  item only on `conversations` → red. Exception (§2.A): on `resumeCenter` the list is the Resume
  Center variant's, asserted exactly.
- e2e `workspace-navigation-convergence` (§2.A): Cognitive Workspace current and painted; titled
  Mission Brief below the column's navigation; no destination label overflows; Back leaves to the
  entry view and the entry re-opens Resume. Mutations: Back a no-op → red; on the pre-fix bundle the
  overflow check lists the three clipped es labels.
- Workspace entry lands on `resumeCenter`; Mission Brief visible without a click when a workspace
  exists. Mutations: route to `conversations`; drop auto-select → red.
- Visual: real-app captures registered as `current`, geometry gate (image-calco `gate_boxes.py`)
  against the Orca references for sidebar width, item order, column positions.

Rollback is per commit. Persisted state: one additive optional field (`globalNavCollapsed`); older
builds ignore it.
