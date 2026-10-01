---
covers: [backlog-infinityops-contract, orca-backlog-source-kind, capture-intent-tool, orca-sync-client, resolve-with-chatgpt-button, resolve-automatically-button]
status: proposed — to be built by the InfinityOps plugin pane after its V1 (Owner decision 2026-09-29)
consumer: Orca X Universal Backlog (docs/reference/universal-backlog.md)
provider: InfinityOps feat/chatgpt-plugin-v1 (vault/specs/t3-chatgpt-plugin-founder-runtime.md)
---

# Contract: Orca X Universal Backlog ↔ InfinityOps ChatGPT plugin

InfinityOps is the ChatGPT **doorway**, not the backlog owner. The canonical backlog lives in Orca X,
on the user's machine. InfinityOps holds only what the user explicitly sends to ChatGPT, and what
ChatGPT captures for Orca to pull. Orca never mirrors its backlog to the server.

Nothing here requires an organization/workspace hierarchy (InfinityOps is 1 user = 1 tenant today).
Orca project identity travels as opaque metadata; InfinityOps never has to model Orca projects.

## C1 — FounderTask source kind `orca_backlog`

- Add `orca_backlog` to `FounderOps.Task` `@source_kinds`. `source_id` = the Orca backlog item id
  (opaque, ≤ 128 chars). The existing `(tenant_id, source_kind, source_id)` uniqueness makes re-send
  idempotent.
- Task payload carries only the minimum context packet Orca built for this item (objective, normalized
  intent, constraints, evidence excerpts, acceptance). Orca has already secret-scanned it.
- `metadata.orca`: `{ item_version, project_refs: [{id, label}], packet_hash }`. `packet_hash` =
  sha256 of the packet, so a result produced against an older packet is refused as `stale` by the
  existing `context_hash` rule.
- Human authority is unchanged: approve / reject stay outside ChatGPT.

## C2 — Tool `capture_intent` (ChatGPT → Orca candidate queue)

- Write tool, scope `backlog:capture`, `readOnlyHint:false`, `destructiveHint:false`,
  `idempotentHint:true`.
- Input: `text` (≤ 4000), optional `project_hint` (free text; never resolved server-side), optional
  `kind_hint`, and the `conversation_ref` ChatGPT exposes if any.
- Stores a row in a tenant-scoped `orca_intent_relay` table: `id`, `tenant_id`, `captured_at`,
  `payload`, `idempotency_key` (server-derived: tenant + normalized text + conversation_ref),
  `pulled_at` (null until Orca acknowledges).
- It creates **candidates only**. Nothing captured here is pending work until Orca's reconciliation and
  the user's accept.
- Write-back on Pro is PROVEN, not expected to fail: on 2026-09-29 16:57 the Owner's ChatGPT Pro/EEA
  account ran the write tool `submit_founder_result`, and `/dashboard/founder` rendered the persisted
  row after a re-read (ChatGPT conversation `6abbedec-b9dc-83eb-b7ec-46c0c93a5176`; prod row id not
  read). This contradicts the OpenAI help-center claim that Pro developer mode is read/fetch only, so
  `capture_intent` is viable on Pro. It stays an interactive lane; Codex remains the unattended one.
- If a write is refused anyway (plan change, workspace policy), the tool returns an explicit,
  product-language refusal, never a silent success.

## C3 — Orca sync client (authenticated, least privilege)

- A distinct OAuth client `orca-desktop` on the same Better Auth authorization server: PKCE S256,
  loopback redirect (`http://127.0.0.1:<port>/callback`) only, first-party consent screen that names
  it, scopes `backlog:sync` only. Refresh-token rotation per the V1 hardening.
- Endpoints under `/api/orca/*`, validated on every call exactly like `/api/mcp` (row lookup; expiry,
  scope, client enabled), tenant from the token:
  - `POST /api/orca/founder-tasks` — upsert a C1 task (idempotent on source_id + item_version).
  - `GET  /api/orca/founder-tasks/:source_id/result` — latest accepted result + its `packet_hash`.
  - `GET  /api/orca/relay?after=<cursor>` — unpulled C2 captures; `POST /api/orca/relay/ack` marks them.
- A foreign id and a missing id return the same response.

## C4 — Buttons in the InfinityOps Founder Queue

- **Resolver en ChatGPT**: pin the task to the user for 30 min server-side (as V1), then open
  `https://chatgpt.com/?q=<encoded "@InfinityOps resuelve mi tarea pendiente">`. The URL carries no task
  data. `?q=` is undocumented → also copy the prompt to the clipboard and show it, so a dead parameter
  degrades to paste. Enabled only with an OAuth grant **and** an observed successful tool call (V1 rule).
- **Resolver automáticamente**: available only when an Orca device with `backlog:sync` is connected and
  has reported a Codex-with-ChatGPT runtime. Marks the task `requested_automatic`; Orca pulls it,
  resolves it locally with Codex on the user's own subscription, and posts the result through C3.
  The server never holds ChatGPT or Codex credentials.

## Evidence the provider pane owes

Negative tests: foreign tenant, wrong scope, a token for `/api/mcp` used on `/api/orca/*` and the
reverse, a stale `packet_hash`, a duplicate capture. A live developer-mode walk on the Owner's account,
labelled production-verified / developer-mode-verified / blocked by provider review / blocked
externally.
