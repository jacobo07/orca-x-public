# RESUMPTION — Orca Cognitive Workspace, W3 (Conversation Reachability)

## 1. Identity

Continuing **W3 of the Cognitive Workspace program**. Spec of record:
`docs/orca-cognitive-workspace-spec.md` (tracked, APPROVED, `covers:` includes `brainstorming`, so
the SDD-OS spec gate is satisfied — do not write a second spec).

**Worktree: `C:\Users\User\Apps\orca-cogws-wt`. Branch: `orca-x/cognitive-workspace`.**
A `/clear` has TWICE reopened this pane in the main checkout on `orca-x/w0-durability-repros`.
Re-prove cwd/repo/branch/HEAD before mutating anything.

**Thesis:** W0/W1/W2 built a durable Orca-owned conversation, a serialized fenced writer and a real
Codex provider gateway — and nothing joined them to a user. W3 closes that circuit.

## 2. Exact state

Base before this slice: `d4126a642`. Seven commits sealed:

| commit | what |
|---|---|
| `8870f150e` | conversations directory on the profile path owner; isolation proven by real store behaviour |
| `29a7bbeed` | ConversationService: list/create/read/commitUserMessage, corrupt rows visible, one-turn admission |
| `33ea5cae9` | IPC (`conversations:list/create/read`) + preload + registration asserted |
| `523de7f3c` | turn runner: refusal order, durable-before-provider, chained durable writes |
| `f8c6599c1` | Codex conversation driver + `conversations:sendTurn` + live turn-event broadcast |
| `919d1da5b` | Brainstorming surface: page, list, notices, rail entry (opt-in), TopLevelView |
| `b2139ff03` | provider-echo duplicate-user-message fix + the real-Codex product reality gate |

**Coherence anchor:** `git grep -l conversation-store -- 'src/*.ts'` must show a PRODUCTION caller
outside `src/main/conversation/`. Before this slice it showed none — that was the RED.

### Proven

- **Real Codex product reality: PASS**, 22.4 s, `codex-cli 0.153.4`, live ChatGPT Plus account,
  read-only sandbox. Real turn → durable → cold service reads it → cold service resumes the SAME
  provider thread → model remembers → one ConversationId across two turns, one provenance entry,
  no duplicate message. Run it with `ORCA_CODEX_REALITY=1`.
- Unit/integration: 135/138 across the conversation surface (3 skipped are the opt-in real gate).
- `tsc` node + cli + web: clean.
- Mutations driven and caught, every restore SHA-256 verified: M10 always-admit (2 red),
  M11 drop-profile-from-path (4 red), M12 drop-unreadable-rows (2 red), unregister-handlers (1 red),
  no-serialization (2 red), drop-user-echo-guard (1 red).

### W3.1 — the Electron gate, and what it found (2026-09-22)

The build was never the blocker. Three findings, in the order they fell:

1. **The spec was bound to `page`, a fixture `orca-app.ts` does not define.** Playwright handed it a
   stock blank Chromium tab. That is why `__store` was "missing", why the screenshot was blank, and
   why the opt-in absence assertion passed. The app window is **`orcaPage`**. Guarded now by
   `pnpm check:e2e-fixture-binding` (340 spec files, 715 callbacks, synthetic red control).
2. **`run-electron-vite-build.mjs` vs the direct binary was a confounded comparison** — the wrapper
   run simply had no `VITE_EXPOSE_STORE`, which `global-setup` supplies itself. The shipped bundle
   bakes `String("true") === "true"`. Grepping a bundle for `__store` proves only that the branch
   survived tree-shaking, never that the gate evaluates true; `import.meta.env.DEV` is folded out.
3. **The Chats rail entry was a dead control.** `WorkspaceActivityRailSection`'s `select` switch had
   no `case 'conversations'`, and `openConversationsPage` did not exist. It rendered, took focus and
   did nothing. The router branch, the page, the list and the opt-in were all correct — only the
   click was missing, and no unit test could see it. The switch is now exhaustive (`never`), so the
   next omission is a compile error.

`global-setup` no longer shells out to `npx`; it runs the repo's own `node_modules/.bin` binary, so
a host with unhealthy npm no longer takes the whole suite down.

The E2E host here runs the app in **Spanish**. `Chats` and `Workspace` survive only because those
keys are absent from `es.json`. Station controls use `[data-workspace-activity="…"]`, not labels.

### NOT proven — this is the open gate

- **No real Electron run.** `tests/e2e/conversations-reachability.spec.ts` is written and is
  `test.fixme` — not passing, marked so rather than deleted. Established while trying:
  `npx` is broken host-wide so global-setup's build fails (build by hand, then `SKIP_BUILD=1`);
  `run-electron-vite-build.mjs` does **not** expose `window.__store`, while
  `node_modules\.bin\electron-vite.CMD build --mode e2e` with `VITE_EXPOSE_STORE=true` **does**
  (verified — `__store` appears in `out/renderer/assets/store-*.js`); and even then
  `window.__store` never reaches the page. A control run of the untouched
  `golden-windows-fresh-startup` spec renders a first-run onboarding wizard, so the renderer is
  healthy and this is harness wiring, not the feature. Do not reach for `seedTestRepo: false` — it
  skips the fixture path that dismisses onboarding.
- No two-window concurrency drill in the real app.
- Mobile: BLOCKED (`mobile/node_modules` absent in this worktree; do not run a broad install).
- Web: SPECIFIED / UNREACHABLE — no consumer this wave.

## 3. Active decisions

- Real Codex turns against the live account are **authorized** (read-only, throwaway cwd, no trust
  pre-seeding).
- Rail entry is **opt-in** (`showConversationsButton`, default false) and sits **second**, because
  "entry point first" is pinned by the rail's own test.
- **No Stop control.** `turn/interrupt` has zero call sites in `src/`.
- **No approval decider.** Conversations pin `read-only`; a tool-requiring prompt gets a visible
  recorded denial.
- Multi-turn via `thread/resume`, not a long-lived peer. Proven in the reality gate.
- No conversation index file; `list()` + `load()` per record, corrupt rows stay visible.
- No `authorId` on messages yet — additive later under a schema bump, which fails closed.

## 4. Next three actions

1. **Finish the real Electron gate.** When the build lands, write
   `tests/e2e/conversations-reachability.spec.ts`: enable `showConversationsButton`, open the rail
   entry, New chat, type, send (auth-required is an acceptable honest outcome if the e2e profile has
   no Codex auth), reload, and assert the conversation is rediscoverable in the list with its
   history. Build with `--mode e2e` or every spec fails; use `pnpm exec playwright`, never `npx`.
2. **Two-window concurrency** in the real app: two windows, same conversation, double send — assert
   one `busy` refusal and no lost message.
3. **Vault/UKDL**: the provider-echo defect and the per-call-factory-defeats-the-queue defect are
   both novel and worth institutionalizing.

## 5. Start instruction

Re-prove the worktree. Run the coherence anchor. Then continue at action 1.

Run tests as
`node node_modules\vitest\vitest.mjs run --config config/vitest.config.ts <paths> --maxWorkers=2` —
invoke vitest directly, because the RTK proxy has reported `PASS (0) FAIL (0)` for a file with a
syntax error. Never run the full suite: it is OOM-killed on this host.

When driving a mutation, ASSERT THE ANCHOR MATCHED before trusting the result. A mutation that
never applied is indistinguishable from one that survived; that happened once here (an `\n` anchor
against a CRLF working tree) and only the applied-check caught it.

`verify-localization-catalog.mjs --fix` sweeps up OTHER panes' missing keys into the shared
`en.json`. Revert it and add only your own block by hand.
