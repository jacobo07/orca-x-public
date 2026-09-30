---
status: all_fixed
fixed: [WR-01, WR-02, IN-01, IN-02]
deferred: [IN-03, IN-04]
---

# Phase 3 review fixes

## WR-01 (fixed) - commit 412e08c51
- Files: `src/main/runtime/orca-runtime.ts`, `src/main/runtime/orca-runtime.test.ts`.
- Root cause: the paired create raced the renderer reply against the caller's abort, so an aborted caller skipped `pendingMobileTerminalCreatesByKey` registration and released the publication throttle early.
- Fix: `createMobileSessionTerminal` no longer hands the caller signal to the create flow. The flow always runs to its own end (reply, registration, surface wait, startup-command delivery, throttle release). `rejectWhenCallerDisconnects` rejects only the caller-facing promise, and only once the create is renderer-owned (headless creates still return their result). The reviewer's "register before send" was not used: the key needs `reply.tabId`.
- Test converted in place: "a paired renderer-owned create still reaches the renderer after its client disconnects" now also pins throttle held, registration after a late reply, and cleanup. Its old `send` assertion was timing-coupled to the removed abort branch and now uses `vi.waitFor`. The #7718 test and the 03-02 headless test stay as written and pass.
- RED (before code change): `expected setBackgroundThrottling not to be called with [true]` (received `false`, then release): throttle freed on caller abort.
- GREEN: orca-runtime.test.ts + session-tabs.test.ts + runtime-rpc-client-disconnect.characterization.test.ts 1200/1200; tsc exit 0.
- Known limit: a mutation-id follower that joins an in-flight create never abandons its wait (it waits for the shared create).

## WR-02 (fixed) - commit 99b0dcbad
- Files: `AGENTS.md`, `docs/reference/detach-stop-cancel-effects.md`.
- Docs now say quit is Detach for remote and runtime-hosted Executions; local PTYs owned by this process end via `killAllPty()`; daemon-backed PTYs survive. Cites `src/main/quit-path-local-runtime-teardown.characterization.test.ts`. No product change.

## IN-01 (fixed)
- File: `src/main/runtime/rpc/methods/workstream-cancel.test.ts`.
- Mobile test now asserts registration in `ALL_RPC_METHODS`, a mobile positive control (`status.get` is not `forbidden`), and a refusal message naming `'workstream.cancel'`.
- RED: with `...WORKSTREAM_CANCEL_METHODS` removed from `methods/index.ts`, 5 of 6 fail, including the mobile test. Bytes saved and restored; `git diff --quiet` exit 0.
- GREEN: 6/6.

## IN-02 (fixed)
- File: `config/scripts/workstream-surface.characterization.test.mjs`.
- The shared reason is replaced by one reason per entry, each true of its own text (constant, code set, type, wire string, registration spread, import path, params type, export, method name). GREEN: 8/8.

## Final run
- orca-runtime.test.ts, session-tabs.test.ts, runtime-rpc-client-disconnect.characterization.test.ts, workstream-cancel.test.ts, workstream-surface.characterization.test.mjs: 5 files, 1214/1214 passed. `tsc --noEmit -p config/tsconfig.node.json` exit 0.
- Env note: vitest needs git on PATH (`C:\Program Files\Git\cmd`); without it 10 unrelated tests fail with `spawnSync git ENOENT`.

## Deferred
- IN-03, IN-04: untouched by instruction.
