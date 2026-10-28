---
gsd_state_version: "1.0"
current_phase: 10
current_phase_name: 2/2
status: unknown
stopped_at: Completed 19-05-PLAN.md (phase 19 human_needed)
last_updated: "2026-10-27T20:45:00.000Z"
last_activity: "2026-10-26 20:30 -- phase 9 two-host live leg (Windows + GEX44, SCRIPTED CLIENT) passed 2 of 2; oracle extended for ConPTY-glued output; both hosts torn down. Earlier: revocation reason fix (6fac32885, 1175cda5d, e7fd002fd); phase 7 live Windows leg (4f6f335a3); worker epoch 2 phases 1-4, 6, 8 (1e828f057, 0a9b58881, 8e6e78c7b, 7c268fa18, a8380b51a, e14a776d2), phase 9 Continue-here gate (f77a64ff8), phase 10 close. Mission ownership moved to this laptop 16:00 (Owner: \"go here\"); the arming pane on C:\\Users\\User (worktree orca-phone-wt) stays idle and is NOT a writer. Previous DWS milestone archived in rb-live history c1f33f4d4e."
state_head: d47194143371044f55af5af60ab9e8023e0b6d10
progress:
  total_phases: 14
  completed_phases: 7
  total_plans: 20
  completed_plans: 16
  percent: 50
---

# STATE: Phone control of a live Orca X session, then DWS convergence

## Current Position

Phase 20 (Off-LAN wake, OOB boundary and institutional close), branch mobile/host-availability, worktree C:\owx-haf: plans 5 of 5 complete, VERIFICATION status human_needed (.planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md). Headline: a wake delivered over the relay meets the broker's own authority, dedupe and refusals (UNIT in-process relay, never M3); can-power-on-oob MEASURED not-supported/hardware_bound_amd_no_amt on this AMD laptop (20-oob-probe-evidence.json, re-run at ac107b5b9); can-wake-remote not-configured everywhere (D-04 option B); wake-proxy-available UNIT, WIRED-BUT-UNRENDERED; rows K, L, M PASS; twelve mutants CAUGHT; G6 in check:host-card-claims. M3 (off-LAN wake from a phone on 5G) is OWNER_BOUND on cloud auth on the broker node plus Owner steps b and c; M4 is HARDWARE_BOUND (no AMT); WOL from S5 with Fast Startup off is OWNER_BOUND. 20-05 (ac107b5b9 reference note + AGENTS.md Host Wake + UKDL proposal, eca2617bb verification): one Knowledge Vault lesson written outside the repo; UKDL entries are a proposal only. Next: the orchestrator runs the fresh-agent test (20-FRESH-AGENT-QUESTIONS.md); then every remaining leg needs the Owner (see Owner summary).

Phase 20 plan history (newest first): 20-04 (78d2ecdb6 RED, b56b5d666 GREEN, 457d44590 rule table, 725c3e194 mutants): check:host-card-claims now runs G6 (config/scripts/host-capability-producer-gate.mjs, called from main; package.json and pr.yml unchanged) over a hostCapabilities section in config/host-card-claims.jsonc that classifies all six ids. can-start-orca (os-probe), can-relay (relay-reported) and can-direct (host-announced) may emit supported. can-wake-lan, can-wake-remote and can-power-on-oob are supported null. A supported literal without a quoted evidence allowance, a missing section or id, an unknown id, a vacuous or missing producer, and a stale allowance each fail. Success line: `check-host-card-claims: 22 labels classified, 2 controls classified, 598 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified.` P20-K1, K2, M1, M2, O1, O2, W1, G1, G2 and G3 are CAUGHT and RESTORE_VERIFIED (20-04-MUTANTS.md). G3 is caught by G5 on the card attribute; the jsonc why is not scanned. Earlier, 20-03 (20558a7a9/0dc47e747, 09c082a38/40ae8309c): src/shared/host-wake-proxy.ts composes wake-proxy-available only from this session's broker answers (connected, a current status.get advertising host.wake-broker.v1, a current host.wake.targets reply with a well-formed target; evidence live-response at the older answer); anything else is unknown with one of seven reasons and planWakeRequest refuses to send (row K broker_not_connected, row M broker_not_announced); UNIT, WIRED-BUT-UNRENDERED, no UI consumer (mobile Wake control deferred, 19 D-13). Old clients still parse exactly the six phase 18 ids (pin passed at once; failing proof is P20-M2 in 20-04). OOB: src/main/runtime/oob-power.ts is types only (powerOn capped at command-accepted, no production implementer); the recording double is imported only by oob-power.test.ts, proven by a whole-src sweep (station control 14355 files incl. main/index.ts, positive control hit). 3 typechecks exit 0; no mobile/ change. Next: 20-04. Earlier, 20-02 (673cdf679/b4ca14e0d, cbd4880ca/422abaa5c, d3754fd99/10d438dd9): status.get reports can-power-on-oob from a read-only CPU-vendor and Intel-MEI probe (host-oob-probe.ts, single-flight, max age 600 s, no timer, primed at both start paths). On AMD it reads not-supported/hardware_bound_amd_no_amt (os-probe); Intel and every read failure read unknown; no branch yields supported. can-wake-remote comes from one producer, describeRemoteWakeCapability, as not-configured/no_wake_broker (D-04 option B). Windows tool spawns use one path rule, src/shared/windows-system-tool-path.ts, which secure-path-windows-acl.ts now imports. Live read-only leg on this laptop: not-supported, AuthenticAMD, MEI 0. Gates: recurring-work total=236 debt=0, host-card-claims OK, durability OK, 3 typechecks exit 0. Next: 20-03. Earlier, 20-01 ( 8f71fa8d2 RED, 2878d23c1 GREEN, 489b4f555 rows, aaaf0edb2 mutants). UNIT in-process relay (never M3): a host.wake.request from a simulated E2EE v2 phone through a loopback relay cell and a real CloudRelayTransport, attached to the real server's MobileSocketWiring, reaches the broker and sends exactly one 102-byte loopback frame; over the relay the replay keeps its wakeId, the ungranted phone gets wake_grant_missing, a foreign wake reads wake_unknown, admin gets forbidden, a relay leg bound to another device is refused by the server with e2ee_error, and a revoke inside the dispatch window gets wake_device_revoked, then unauthorized/device_revoked. P20-L1 and P20-L2 CAUGHT and RESTORE_VERIFIED (20-01-MUTANTS.md). 20-01 changed no production code.

Phase 19 (Wake-on-LAN capability and the LAN Wake Broker), branch mobile/host-availability, worktree C:\owx-haf: plan 5 of 5 complete, VERIFICATION status human_needed (19-05: 0ee75031d, 43e170ba2, 555cb218b). 19-05: out/ built on GEX44 at 1de3a0c85 in a disposable root (sha256 633f3a15...2126 both ends, NONE_P19); a SCRIPTED CLIENT live leg on a disposable --serve-wake-broker host (scratch profile, loopback) saw a granted wake send exactly one 102-byte frame to a loopback listener, B refused wake_grant_missing, a duplicate replayed and a new requestId adopted (listener 2 = 2 distinct wakes), no MAC in 13 phone replies, and a no-flag host refusing wake_broker_disabled without the capability; Owner orca-devices.json hash unchanged, reap proven. WOL probe re-measured unknown/firmware_unverified. P19-M1..M6 CAUGHT and RESTORE_VERIFIED. SC3 LAN Product Reality OWNER_BOUND (b BIOS, c always-on node; a measured armed); live revoke not claimed (Settings-only); mobile Wake control DEFERRED (D-13). Next: /gsd-verify-work 19 (Owner) or phase 20. Earlier plans: 19-01, eca5f1923 + summary d47194143; 19-02, 16f4f8ead; 19-03, 9a8b9c4f1; 19-04, bc5f570ae. 19-04: the Owner administers the broker locally with `orca wake target add|list|remove` and `orca wake grant add|remove|list` over six host.wake.admin.* methods that refuse any non-local caller (remote_caller_refused); the CLI refuses ORCA_CLI_CWD (SSH relay), --environment/--pairing-code and a remote client with remote_invocation_refused before any call (shared assertLocalInvocation in src/cli/runtime/local-invocation.ts); residual: no CLI device listing. can-wake-lan is measured by a read-only WOL probe at both start paths; this laptop reads unknown/firmware_unverified. The LAN Wake Broker core is built (19-02) and now enabled only by `orca serve --wake-broker` (19-03): status.get advertises host.wake-broker.v1 only while enabled, an unreadable state file fails closed, runtime-rpc attaches a live device authority (assertDeviceStillAuthorized), a successful revoke or a discarded pending pairing drops the device's grants, and the three phone methods are on the mobile allowlist (no admin name, no revoke RPC). In-process proof on a real RuntimeRpcServer: 1 loopback frame before revoke, still 1 after, refusal wake_device_revoked.

P0 (2026-10-27, Owner mission "crash-proof mobile remote session entry"): phase 11 in .planning/phases/11-mobile-session-entry-crash/11-VERIFICATION.md. Root cause PROVEN on the Owner's S25 Ultra: the sideloaded APK 0.0.43 (2026-09-14) lacks the ExpoTwoWayAudio native module its JS imports, so opening any session threw at route load and Android finished the activity. Fixed 328971c74, contained a8d7bfca2, build gate 2a4f2ef6d. Fixed APK built (sha256 ca68faa3…21df), staged on the phone, and installed by the Owner as an update; P0 done-gate MET 2026-10-27 ~10:40 (PHYSICAL DEVICE, OWNER-OBSERVED: host > Orca X session opened, Owner typed into this pane from the phone; host saw the device at 09:40:31Z; no logcat). Resume: adb over Wi-Fi (Developer options > Wireless debugging, adb pair) → instrumented failure matrix, fresh-output send, reconnect, foreground, revocation; then Mobile Workstation. adb lives in the session scratchpad (gone after reboot): fetch platform-tools again from dl.google.com.
Phase: 10 of 10 -- complete (2/2). Milestone NOT closable: phases 5, 7 and 9 are PARTIAL (human_needed, see Deferred Verification). Phase 8 ran its Orca-side legs ahead of 7 under the unattended rule.
Base: rb-live c1f33f4d4e (pushed 2026-10-19), branch mobile/phone-control, worktree C:\owx-pc on the Owner's laptop (C:\Users\Jacobo).
Last activity: 2026-10-26 20:30 -- phase 9 two-host live leg (Windows + GEX44, SCRIPTED CLIENT) passed 2 of 2; oracle extended for ConPTY-glued output; both hosts torn down. Earlier: revocation reason fix (6fac32885, 1175cda5d, e7fd002fd); phase 7 live Windows leg (4f6f335a3); worker epoch 2 phases 1-4, 6, 8 (1e828f057, 0a9b58881, 8e6e78c7b, 7c268fa18, a8380b51a, e14a776d2), phase 9 Continue-here gate (f77a64ff8), phase 10 close. Mission ownership moved to this laptop 16:00 (Owner: "go here"); the arming pane on C:\Users\User (worktree orca-phone-wt) stays idle and is NOT a writer. Previous DWS milestone archived in rb-live history c1f33f4d4e.

## Owner summary

Plain language, for the Owner. Labels say how each thing was proven.

What works now:
- The phone opens a session on this PC without crashing (phase 11 P0 fix): PHYSICAL DEVICE, OWNER-OBSERVED.
- Orca X can run as a background host service and say whether it is up (phase 17): PASS on a disposable serve host, SCRIPTED CLIENT.
- Each host reports what it can do (start Orca, relay, direct, wake, power) and never claims what it has not measured (phase 18, plus the phase 20 G6 gate in `pnpm check:host-card-claims`): UNIT + gate + mutants. The card on a real phone is still owed.
- A LAN Wake Broker (`orca serve --wake-broker`) sends a magic packet only for a paired phone you granted, refuses everyone else, and never says "woken" (phase 19): SCRIPTED CLIENT live leg on a disposable host + UNIT in-process.
- The same wake, delivered through the relay, meets the same checks (phase 20): UNIT in-process relay. This is not the real off-LAN test.
- This PC cannot be powered on out of band: it is AMD and has no AMT (phase 20): MEASURED, read-only.

What needs you, in order:
1. BIOS (step b): turn on "Resume by PCI-E / LAN" and turn off ErP on the desktop PC.
2. An always-on LAN node (step c) running `orca serve --wake-broker` (the PC that sleeps cannot be its own broker).
3. Cloud auth for the relay on that node (today the relay reports `cloud_auth_not_configured`).
4. The LAN wake test: the ordered procedure in .planning/phases/19-wake-on-lan-capability-and-the-lan-wake-broker-m2/19-VERIFICATION.md (section "LAN Product Reality: OWNER_BOUND"); then `/gsd-verify-work 19`.
5. The off-LAN wake test from a phone on 5G (M3): the ordered procedure in .planning/phases/20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4/20-VERIFICATION.md (section "M3: OWNER_BOUND"); then `/gsd-verify-work 20`.
6. Optional: turn Fast Startup off and try a wake from full shutdown (S5); it is unmeasured and never assumed.
7. The owed phone and Owner-PC legs: `/gsd-verify-work 5`, `/gsd-verify-work 7`, `/gsd-verify-work 9`, `/gsd-verify-work 17`, `/gsd-verify-work 18` (what each owes is in Deferred Verification below).
8. Push and merge branch mobile/host-availability: Owner-only. Nothing has been pushed.

## Agent resume block

Imperative, for a fresh agent with no chat context:
- Work in worktree C:\owx-haf on branch mobile/host-availability. Read HEAD with `git -C C:\owx-haf log -1 --format=%H` (local only, never pushed). Production code last changed at 90b0c0044 (20-04 close); phase 20 verification is eca2617bb.
- Obey the Laws (binding) section below. Never push or merge; do not touch the primary checkout; git through PowerShell.
- Deferred rows and their resume commands (the Deferred Verification table below): 5 `/gsd-verify-work 5`, 7 `/gsd-verify-work 7`, 9 `/gsd-verify-work 9`, 17 `/gsd-verify-work 17`, 18 `/gsd-verify-work 18`, 19 `/gsd-verify-work 19`, 20 `/gsd-verify-work 20`. Every one is human_needed.
- Proven test commands (single files, this laptop): `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/wake-broker-relay-dispatch.test.ts`; `pnpm exec vitest run --config config/vitest.config.ts src/shared/host-wake-proxy.test.ts src/main/runtime/oob-power.test.ts`; `pnpm run check:host-card-claims` (success line ends `6 capability producers classified.`); live read-only OOB leg with `$env:ORCA_LIVE_OOB_PROBE='1'` on `src/main/runtime/host-oob-probe.live.test.ts`.
- Next action: if the orchestrator's fresh-agent result is not yet appended to 20-VERIFICATION.md, that is the next step. Otherwise no autonomous phase 20 work remains: M3 waits on Owner steps 1-3 above, M4 is HARDWARE_BOUND. New work (mobile Wake control, 19-REVIEW IN-01..IN-05) needs a new plan.
- Do not run milestone audit, complete or cleanup while any phase is human_needed (phases 5, 7, 9, 17, 18, 19, 20).

## Completed phases (evidence in .planning/phases/NN-*/)

- Phase 1 (3/3): row reasons and owner map in 01-OWNERS.md; RED oracle test.
- Phase 2 (2/2): oracle src/shared/terminal-fresh-output-oracle.ts; scope proof src/main/runtime/rpc/terminal-send-mobile-scope.test.ts; M1-M3 CAUGHT.
- Phase 3 (2/2): src/main/runtime/runtime-rpc-mobile-reconnect-revocation.test.ts; M4, M5, M6b, M7 CAUGHT; M6 equivalent (handles retained per PTY incarnation). Revocation authority: device-authorization.ts assertDeviceStillAuthorized (runtime-rpc.ts:1118 frames, :1756 RPC).
- Phase 4 (2/2): mobile/src/worktree/host-switch-row-isolation.test.ts; GEX44 34/34, P4-M1..M3 CAUGHT, root torn down.
- Phase 5 (1/2, human_needed): mobile/src/session/use-mobile-terminal-paste.test.ts; GEX44 44/44; P5-M1b, M2, M3 CAUGHT; tokens from mobile-theme.ts with positive control. Captures NOT done.
- Phase 6 (2/2): measured, no code; provider leg EXTERNAL_BLOCKED.
- Phase 7 (1/2, human_needed): live Windows leg on the Owner's installed Orca X with a SCRIPTED CLIENT (src/main/runtime/mobile-live-windows-leg.live.test.ts, phone + witness legs passed 2026-10-26 18:19): FRESH, reconnect identity, foreign refused, revoke terminates the device's socket and the revoked token cannot re-auth, witness ABSENT for the revoked nonce + FRESH control. The handshake now names reason device_revoked and the phone latches at once (6fac32885, 1175cda5d). Phone UI leg still owed. Headless Linux spec: tests/e2e/headless-paired-mobile-terminal-fresh-output.spec.ts (GEX44, P7-M1 CAUGHT).
- Phase 8 (2/2): scope test extended (stale desktop+mobile writes refused, phone floor accepted, desktop refused); relay tally + gate 13/13; placement 69/69; P8-M1..M6 CAUGHT. X units: X05/X16/X18 code on branch, PARTIAL pending two-host runs; X06/X19 NOT on this branch (need a port from GEX44 ~/missions/dws-exec). DWS matrix unchanged.
- Phase 9 (1/2, human_needed): two-host live leg passed 2/2 (src/main/runtime/mobile-live-two-host-leg.live.test.ts; Windows laptop serve host + GEX44 serve host, one SCRIPTED CLIENT): per-host scoping by FRESH/ABSENT, cross-host handles refused, real ssh carrier cut on B with A still FRESH, B reattached to the same handle/ptyId and its ticker advanced 0->16. Row 75 stays PARTIAL on its own residual (rows 64, 66). Continue here refuses a dirty or unreadable source (86/86, P9-M1..M3 CAUGHT); Workstream identity not carried (UWCP absent). Finding: Windows ConPTY terminal.read lines are not screen lines (output glued to the echo); oracle extended narrowly, product defect open.
- Phase 10 (2/2): verifier re-run at f77a64ff8 = 48/76 PASS (ABSENT 10, PARTIAL 18), CONTRACT INVALID, unchanged; fresh read-only agent answered 7/7 questions from durable state with citations (gaps it found fixed here).
- tsc --noEmit: config/tsconfig.tc.web.json exit 0 and config/tsconfig.node.json exit 0, both on the laptop 2026-10-26 (no longer owed).

## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| 5 | verification_deferred_human | /gsd-verify-work 5 (captures: keyboard open/closed, selector open, long names, many runtimes; Android 14 emulator on C:\Users\User or a paired phone) |
| 7 | verification_deferred_human | /gsd-verify-work 7 (Windows app + paired phone or labelled emulator; run the headless spec on Windows; live revoke from Settings) |
| 9 | verification_deferred_human | /gsd-verify-work 9 (host side done with a SCRIPTED CLIENT; owed: a phone or labelled emulator switching hosts in the host picker) |
| 18 | verification_deferred_human | /gsd-verify-work 18 (model, producer, card and check:host-card-claims PASS with 5 mutants CAUGHT, f9204b5ad; owed: the card on a real phone or labelled emulator, and a live status.get hostAvailability read from a disposable serve host after an out/ rebuild on GEX44) |
| 19 | verification_deferred_human | /gsd-verify-work 19 (SC1 measured unknown/firmware_unverified; SC2 PASS: SCRIPTED CLIENT live leg on a disposable --serve-wake-broker host + UNIT in-process revoke, six mutants CAUGHT, 555cb218b; owed: LAN Product Reality OWNER_BOUND on steps b (BIOS Resume by PCI-E/LAN, ErP off) and c (always-on LAN node running orca serve --wake-broker), step a measured armed; the mobile Wake control is DEFERRED under D-13) |
| 17 | verification_deferred_human | /gsd-verify-work 17 (SC1, SC2a, SC2b, SC3a PASS on a disposable serve host, SCRIPTED CLIENT, a0ea321d0; owed: Owner go for the disposable Task Scheduler leg incl. RestartOnFailure, then rows O1-O6 in 17-VERIFICATION.md on the Owner's PC) |
| 20 | verification_deferred_human | /gsd-verify-work 20 (SC1 transport independence UNIT in-process relay + P20-L1/L2, SC2 PASS with can-power-on-oob MEASURED not-supported, SC3 rows K/L/M + twelve mutants + G6, eca2617bb; owed: M3 OWNER_BOUND on cloud auth for the relay on the broker node plus steps b (BIOS Resume by PCI-E/LAN, ErP off) and c (always-on LAN node running orca serve --wake-broker), procedure in 20-VERIFICATION.md; M4 HARDWARE_BOUND (AMD, no AMT); WOL from S5 with Fast Startup off OWNER_BOUND; mobile Wake control DEFERRED (19 D-13); fresh-agent result appended to 20-VERIFICATION.md by the orchestrator) |

## Owner decisions

- 2026-10-27 ~00:30: "cuando termines pushea instala y apaga el pc de forma autonoma". Push of mobile/phone-control authorized for this run (never main); install attempted and staged (lock screen needs the Owner); laptop shut down at the end.
- 2026-10-27 00:13: Owner paired a PHYSICAL phone (S25 Ultra) to the installed Orca X and enabled Wireless debugging; adb pairing code was used once and not recorded.
- 2026-10-26 18:00 (phase 7): Owner chose (a). A scripted phone-protocol client may pair to the Owner's running Windows Orca X. Evidence is labelled SCRIPTED CLIENT, never physical or emulator; the device is revoked at the end and the revoke is proven by a refused mutation; no extra paired device is left; the Owner's windows and sessions are never restarted or closed. Runner: src/main/runtime/mobile-live-windows-leg.live.test.ts (ORCA_LIVE_LEG=phone, then witness).
- 2026-10-26 20:10 (phase 9): Owner said "hazlo tu unattended". Host A became a disposable Windows serve host on this laptop (worktree Electron, GEX44-built out/ of the same HEAD, E2E disposable home, loopback), so no Owner click and no Owner profile were needed.
- Harness gap found 2026-10-26: gsd_mission directives reach only a FRESH worker's card; a turn-continued worker never saw this answer, and the mission HALTED no_progress at 17:51 waiting for it.

## Blocked (resource)

- Phase 5 captures: no emulator here (laptop law) and GEX44 cannot run one (/dev/kvm root:kvm, kobii not in kvm, no Android SDK; joining kvm needs root on a shared host).

## GEX44 mobile test recipe

git bundle HEAD -> scp to /tmp/orca-phone-pN-<ts>; PATH from ~/orca-env/env.sh (node24 v24.21.0, pnpm 10.24.0); `pnpm install --frozen-lockfile --ignore-scripts` in mobile/; script refuses any root outside /tmp/orca-phone-p*; tear down after. Ship scripts as no-BOM LF files via `ssh gex44 bash -s < file`.
Build needs native modules: after the `--ignore-scripts` install run `pnpm rebuild node-pty` before `build:electron-vite`, else the plain-node-entry guard fails to load pty.node (measured phase 17, 2026-10-27).
Serve host: build:electron-vite + ensure:electron-runtime, then `xvfb-run electron <repo> --serve --serve-json --serve-port P --serve-bind-host 127.0.0.1 --serve-pairing-address 127.0.0.1 --serve-mobile-pairing`; register the project with repo.add over the runtime pipe/socket from orca-runtime.json (--serve-project-root does not register it). A Windows serve host runs the same out/ with the worktree's electron.exe and ORCA_E2E_USER_DATA_DIR + ORCA_E2E_HOME_DIR = USERPROFILE so no real-home hook or trust file is written.

## Decisions (unattended)

- 2026-10-26 Phase 1 RED is a unit test, not e2e: the laptop cannot build for the headless paired harness. Safe: reversible, internal.
- 2026-10-26 Phase 2 adds no wire field for host scope; per-host connection + runtime-local handle map already fences it. Safe: no wire change, proven by mutants.
- 2026-10-26 Phase 4 runs mobile tests on GEX44 rather than installing mobile deps on the laptop (RAM law). Safe: disposable root, torn down.
- 2026-10-26 Phase 9 criterion 2: "not offered" implemented as a refusal at the effect on a dirty or unreadable source (fail closed); Workstream identity left unclaimed because UWCP is absent. Safe: reversible, internal, no wire change.
- 2026-10-26 Milestone audit/complete/cleanup NOT run: three phases are human_needed, so completing would archive unverified legs as done. Safe: nothing archived, nothing lost.
- 2026-10-26 Removed a stale worktree index.lock (no live git process, 262 s old; backup in job tmp). Safe: scratch file, backed up.
- 2026-10-26 Phase 9 oracle: a line ending in the exact sent text followed by `marker nonce` counts as FRESH (ConPTY glue). Safe: the echo alone cannot contain the expected line; control tests refuse partial echoes and other prefixes; only tests consume the oracle.
- 2026-10-27 (epoch 2, m-cf9e66a07a6f) Phase 19 researched before planning (WOL probing, dgram broadcast and grants were new). Safe: docs only.
- 2026-10-27 Phase 19 plan check: revoke row proven in-process (no revoke RPC added), refusal code `wake_device_revoked`, discard purge added. Safe: no new security surface; labels honest.
- 2026-10-27 Phase 19 plans executed sequentially in this worktree (8 GB laptop, one shared git index). Safe: reversible, internal.
- 2026-10-27 lint-staged can leave a stale pre-format index after a commit; reset only index entries whose tree equals HEAD. Safe: working tree untouched, HEAD holds tested content.
- 2026-10-27 `gsd-tools verification.status` reads `stale` for phases 18 and 19 although only `.planning/` changed after VERIFICATION; routed by the VERIFICATION frontmatter (`human_needed`). Safe: no state claimed beyond the file.
- 2026-10-27 Phase 19 review WR-01 fixed (cab270fb0, b88f111c5): wake device check is present/absent/unknown; grants fail closed on an unreadable registry. IN-01..IN-05 recorded in 19-REVIEW.md, not fixed. Safe: tests RED then GREEN, 83/83.
- 2026-10-27 Phase 19 human_needed: continued to phase 20 without validation (unattended), deferred row above. Safe: nothing archived; resume command recorded.
- 2026-10-28 Phase 20 D-04 option B: can-wake-remote is not-configured/no_wake_broker on every host; a phone learns broker acceptance from host.wake-broker.v1 plus host.wake.targets. Safe: no supported claim without evidence; additive, pinned by P20-W1 and G6.
- 2026-10-28 Phase 20 plans 20-01..20-05 run sequentially in this worktree (8 GB laptop, one shared git index). Safe: reversible, internal.
- 2026-10-28 Phase 20 UKDL entries written as a proposal only (20-UKDL-PROPOSAL.md); the Power Pack UKDL was read only (sha256 equal before and after). Safe: no shared file edited; the Owner applies it in the Power Pack checkout.
- 2026-10-28 Phase 20 Knowledge Vault lesson written as one new local file (~/.claude/knowledge_vault/lessons/host-wake-packet-sent-is-not-a-host-woken.md, not committed); no existing vault file edited. Safe: local, reversible, internal.
- 2026-10-28 Phase 20 fresh-agent test run by the orchestrator after 20-05 (question set and rubric in 20-FRESH-AGENT-QUESTIONS.md), not by the plan executor. Safe: read-only agent; gaps are fixed in STATE.md.
- 2026-10-28 Milestone audit/complete/cleanup NOT run: phases 5, 7, 9, 17, 18, 19 and 20 are human_needed. Safe: nothing archived, nothing lost.
- 2026-10-28 docs/reference/host-wake-broker.md staged with `git add -f` because .gitignore ignores docs/** (same as the tracked detach-stop-cancel-effects.md and terminal-preview-observers.md); .gitignore unchanged. Safe: one reviewed file, reversible.

## Laws (binding)

- You are already in the work tree. Do not call EnterWorktree or ExitWorktree.
- Never push, never merge to main. Pushing is Owner-only.
- Do not touch the primary checkout (C:\Users\Jacobo\Desktop\Cursor Projects\Orca X), C:\ox, or any other worktree.
- Fresh output proves a live-control claim. Terminal history containing the nonce proves nothing.
- UNKNOWN is never zero and never offline. A negative needs a positive control that could have seen the object.
- DWS extends the mobile RPC owner. Do not build a second remote-control transport.
- Emulator evidence is labelled emulator. DONE for a GSD unit is not PASS for a DWS row.
- Laptop: 8 GB, about 2.5 GB free. Single vitest files run here (measured 7 s). No emulator, no full build, no full suite here: heavy runs go to GEX44 (ssh alias gex44, ~49 GB free), in a disposable root, never in an existing ~/orca-* tree.
- node_modules in this worktree is a junction to C:\ox\node_modules (root lockfile identical). mobile/node_modules is not installed yet.
- Use git through PowerShell. No Bash for git on this host.

## Facts measured 2026-10-26 on this laptop (re-verify before relying)

- DWS verifier (node config/scripts/check-dws-completeness.mjs) at f758bd57f and again at f77a64ff8: 48 of 76 PASS, ABSENT 10, PARTIAL 18, verdict CONTRACT INVALID. Rows 59, 70, 73 PASS. Rows 12, 33 PARTIAL (blocked on UWCP control verbs, CPP stages after S4-22). Row 75 PARTIAL (rows 64, 66 live legs partial). Row 39 ABSENT, OUT-OF-PROGRAM since 2026-10-18 (stale-write refusal rests on UWCP log ordering).
- Old GEX44 tree dws/rebaseline ca3a66869 gives 22 of 76; it is stale. No GEX44 ~/orca-* tree is on this branch.
- Mobile terminal slices 1-4 (composer and key row, header and search, host and runtime pickers, output card) are on this branch; device-gated.
- Host RPC: terminal.list/read/send/subscribe/multiplex/create/stop in src/main/runtime/rpc/methods/terminal.ts; agent-session.ts for Agent turns. terminal.send scopes by terminal handle (stale -> terminal_handle_stale) and a per-client input lock; host scope is the per-host connection.
- Mobile caller of terminal.send: mobile/app/h/[hostId]/session/[worktreeId].tsx. Headless paired harness: tests/e2e/helpers/headless-paired-runtime-host.ts.
- Live two-host harness: src/main/runtime/mobile-live-two-host-leg.live.test.ts with steps in mobile-live-leg-steps.ts (skipped unless its ORCA_LIVE_* env is set).
- Orca X desktop is running on this laptop (the Windows host for Phases 2-7).
- Owner's Orca X has no paired device: the Owner revoked the phase 7 witness; orca-devices.json is `[]` (read-only check 2026-10-26 23:40).
- GEX44 DWS units X05, X06, X16, X18, X19 sit at OWNER_BOUNDARY (AMR cap); classify, do not blindly relaunch.

## Owner-only

Install the staged crash-fix APK on the S25 Ultra (unlock needed); re-enable Wireless debugging for the next device leg; interactive provider login and real quota spend; merge (and any push beyond the 2026-10-27 authorization).

## Token budget

Mission about 6M: scan 0.4M (0.2M spent), implementation 2M, tests and Product Reality 2.3M, handoff reserve 1.3M.

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 17 P01 | 45min | 3 tasks | 8 files |
| Phase 17 P02 | 60 min | 3 tasks | 15 files |
| Phase 17 P03 | 25 min | 3 tasks | 8 files |
| Phase 18 P01 | 18min | 3 tasks | 14 files |
| Phase 18 P02 | 17m | 3 tasks | 9 files |
| Phase 19 P01 | 17min | 3 tasks | 11 files |
| Phase 19 P02 | 50min | 3 tasks | 15 files |
| Phase 19 P03 | 23min | 3 tasks | 13 files |
| Phase 19 P04 | 55min | 3 tasks | 13 files |
| Phase 20 P02 | 22min | 3 tasks | 13 files |
| Phase 20 P04 | 17min | 3 tasks | 6 files |

## Decisions

- [Phase 10]: 17-01: serve and desktop start the relay through one memoized createHostRelayOwner(); readiness status is null until the broker emits
- [Phase 10]: 17-02: SERVE_AUTOSTART_FLAG lives in src/shared so the CLI task builder and main lock-held exit share one literal
- [Phase 10]: 17-02: autostart status treats only ObjectNotFound as absent; any other lookup error is autostart_status_unreadable
- [Phase 10]: 17-03: Task Scheduler leg OWNER_BOUND, restart-on-failure UNMEASURED (no Owner go)
- [Phase 10]: 17-03: GEX44 recipe needs pnpm rebuild node-pty after --ignore-scripts install for build:electron-vite
- [Phase 10]: 18-02: an ok status.get whose result is not an object reads as no answer (power/orca unknown), not version mismatch
- [Phase 10]: 18-02: GEX44 pnpm is 12.15.0 via corepack (mobile packageManager), not 10.24.0
- [Phase 10]: 19-01: unelevated Get-NetAdapterPowerManagement fails (system error 31) on the Realtek NIC; probe falls back to *WakeOnMagicPacket and an unreadable Ethernet reads unknown/wol_adapter_unreadable
- [Phase 10]: 19-01: this laptop measures can-wake-lan unknown/firmware_unverified (Realtek Enabled and wake_armed)
- [Phase 19]: 19-02: wake refusals use wake_device_revoked; device_revoked stays the dispatch/E2EE latch reason and no wake refusal carries reason/data.reason device_revoked
- [Phase 19]: 19-02: the broker re-runs device, grant and target at the send; a failed wake is neither replayed nor adoptable
- [Phase 19]: 19-02: host.wake.* carry no launch effect flag (effect-class registry stays at four)
- [Phase 19]: 19-02: wake state publishes via an explicit writeDurableSecureJsonFile call (fsync before rename at secure-file.ts:117-122); check:durability-contracts finds barriers by call site
- [Phase 19]: 19-03: the broker starts only behind serveOptions.wakeBroker in the serve branch (never desktop); host.wake-broker.v1 is pushed by getStatus only while enabled
- [Phase 19]: 19-03: the wake device authority is a live closure over runtime-rpc's current deviceRegistry; an absent or unavailable registry refuses requests and keeps grants (unknown is not absent)
- [Phase 19]: 19-03: revokeAndTerminate (on success) and discardPendingMobilePairingDevice (after removal) drop wake grants; a failed purge is logged, never thrown, and the effect still refuses wake_device_revoked
- [Phase 19]: 19-03: serve-electron-flag-parity was red since d9cd43d1f on '--serve-bind-host'; fixed by naming the flag at the getServeOptions call site, test unmodified
- [Phase 19]: 19-04: every host.wake.admin.* method refuses a non-local caller with remote_caller_refused before resolving the broker; admin names stay off the mobile allowlist
- [Phase 19]: 19-04: grantAdd needs an attached authority (else wake_broker_unavailable) and deviceExists (else wake_device_unknown); while the registry is unavailable deviceExists says yes, so such a grant authorizes nothing until the effect re-judges the token
- [Phase 19]: 19-04: orca wake refuses ORCA_CLI_CWD, --environment/--pairing-code and a remote client with remote_invocation_refused before any call; wake joins shouldIgnoreRemoteSelection
- [Phase 19]: 19-04: normalizeMac moved to src/shared/host-wake.ts (CLI tsconfig cannot reach src/main); WAKE_COMMAND_SPECS spread in specs/index.ts (specs/core.ts at its 300-line cap); no CLI device listing (residual)
- [Phase 20]: 20-01: relay test devices come from DeviceRegistry.addDevice (createPairingOffer coalesces unscanned mobile offers onto one pending device); the relay phone reports a handshake cause so a refused binding (e2ee_error) is told apart from a timeout; no production code changed
- [Phase 20]: 20-02: can-power-on-oob is measured read-only (AMD not-supported/hardware_bound_amd_no_amt; Intel and any failure unknown; never supported); a missing vendor reads oob_cpu_vendor_unreported
- [Phase 20]: 20-02: can-wake-remote is produced only by describeRemoteWakeCapability (not-configured/no_wake_broker, D-04 option B)
- [Phase 20]: 20-02: src/shared/windows-system-tool-path.ts is the one System32 path rule (ACL module and OOB probe); index.ts gained the oob source in the same commit that made it required, so typecheck:node never went red
- [Phase 20]: 20-03: wake-proxy-available comes only from this session's broker answers (connected, current status with host.wake-broker.v1, current targets with a well-formed entry); lastConnectedAt null reads broker_not_connected; UNIT, no UI consumer
- [Phase 20]: 20-03: OobPowerController is a type alias (oxlint consistent-type-definitions) with no production implementer; the recording double throws when a test outruns its script and only oob-power.test.ts imports it
- [Phase 20]: 20-04: G6 lives in config/scripts/host-capability-producer-gate.mjs and runs inside check:host-card-claims; an entry without a supported key fails (absent is not null); producer regions are scanned per function, comments stripped
- [Phase 20]: 20-04: G5 scans the card's control attributes, not the jsonc why; P20-G3 is counted on the MobileHostCard attribute plant

## Session

**Last session:** 2026-10-28T11:36:00.000Z
**Stopped at:** Completed 20-04-PLAN.md
**Resume file:** None
