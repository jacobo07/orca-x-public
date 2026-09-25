# Cognitive Workspace — product surface and connected applications

Status of the UI wave built against the supplied desktop/mobile references, and the KobiiCraft
Studio connection. Branch `orca-x/cogws-product-surface`. Evidence is real Electron under xvfb on
GEX44, pinned to the committed SHA.

| Capability | Status |
|---|---|
| Roster: Agents / Threads / Projects from one shared projection | **LIVE** |
| Header: agent, project chip, location chip from the turn runner's resolver | **LIVE** |
| Context rail: Project · Execution (location, provider, credential) · Agent · Provider turns | **LIVE** |
| Layout by the workspace's own width (wide / medium / narrow) | **LIVE** |
| Connected applications on a Project; status probe; embedded surface | **LIVE** |
| Studio CONNECTED state | **PLANNED** — needs one Owner OIDC sign-in in the Studio view |
| Mobile roster / chat / context | **PLANNED** — needs capability-gated host RPC first |
| Tools / Files / Plan / Memory tabs, Tasks and Knowledge cards | **ABSENT** — no owner produces them |
| Studio creative pipeline cards (evidence, tournaments, render queue) | **ABSENT** — Studio exposes no such API |

## Design difference log

| Reference | Implemented | Why | Source of truth |
|---|---|---|---|
| Global nav Home/Projects/Agents/Tasks/Knowledge/Runtime/Audit | Orca's existing activity rail | the rail already is the global nav | `workspace-activity-items.ts` |
| Green "Online" beside the agent | no status dot; location chip with tone | an agent is a record, not a process; nothing produces "online" | `AgentsPage.tsx` note, `agent-grounding.ts` |
| "Model: Claude Sonnet 4.6" | "Chosen by the provider; not recorded" | the driver is Codex and records no model | `conversations.ts` driver wiring |
| "GEX44 · Online" chip | "This computer" / "Remote host — refused" | remote turns are refused until W-C6; "online" ≠ "executing there" | `agent-project-location.ts` |
| Memory: Enabled · Uptime · Last action | omitted | no producer | — |
| Chat / Tools / Files / Plan / Memory tabs | no tab row | only Chat has an owner; no empty tabs | — |
| Active Tasks, Knowledge (12 items) | omitted | no agent→task or knowledge owner | spec gap 6 |
| KobiiCraft Studio as a second shell ("Creative Workspace") | Studio as a connected app of the project | one workstation, no duplicate authority | this doc |
| LuckyArena pipeline card | none | no producer in Studio | Studio `W1_CAPABILITY_AUDIT.md` |
| Three fixed columns at every width | context rail overlays below 1120px of workspace width; roster/chat alternate below 760px | Orca's side panel takes width a viewport breakpoint cannot see | measured: chat at 0px at a 1024px window |

## Connected application contract

- Declared by a person: label, https origin, optional sign-in origins. Persisted on the Project,
  carried through id promotion, re-validated on every read.
- Main mints the id and the partition `persist:orca-connected-app-<id>`; the renderer never names
  either.
- Status = health + session, observed inside the app's partition: `connected`, `auth-required`,
  `degraded`, `unreachable`, `unknown`. Never on a timer.
- Guest: may start only on its own origin; navigates within origin + sign-in origins; other web
  URLs go to the system browser; popups denied; no permissions, no downloads, no Orca bridge.
- Mobile: not implemented. The web client says so instead of failing.
