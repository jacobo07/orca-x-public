# Phase 17 deferred items

Out-of-scope failures found while executing 17-01. Each fails identically on the pre-plan tree
(c9525e85f, index.ts restored from that commit and the test re-run), so 17-01 did not cause them.

| Found in | Test | Failure | Likely cause |
|----------|------|---------|--------------|
| 17-01 Task 2 | src/main/startup/desktop-startup-ordering.test.ts "passes the startup barrier into PTY handlers without blocking window creation" | anchor `Promise.resolve(desktopWindow ?? openMainWindow())` returns -1 | index.ts now opens the first window with a restore plan argument; anchor text is stale |
| 17-01 Task 2 | same file, "bounds WSL reconciliation before serve RPC while leaving desktop startup independent" | a desktop-window anchor returns -1 | same stale window-open anchor |
| 17-01 Task 2 | same file, "reconciles retained Codex homes after authoritative daemon inventory" | desktop anchor returns -1 | same stale window-open anchor |
| 17-01 Task 3 | src/cli/serve-electron-flag-parity.test.ts "emits the same --serve-* names the CLI spawns with and the main process reads" | getServeOptions slice lacks `'--serve-bind-host'` | CLI spec emits a flag the main-process parser does not read (or reads under another spelling) |
