---
phase: 11-mobile-session-entry-crash
status: human_needed
verified: 2026-10-27
score: 3/3
human_verification:
  - "Session-entry failure matrix on the new build (host disconnected, missing session/worktree, old host), instrumented: re-enable Wireless debugging so logcat can be read."
  - "Fresh-output send from the phone composer, reconnect, background/foreground, revocation, then Mobile Workstation."
---

# Phase 11 Verification: mobile app closes when a session is opened

| # | Criterion | Evidence | Result |
|---|---|---|---|
| 1 | Real-device crash characterized, first bad layer named | logcat on the Owner's phone (below) | MET |
| 2 | Deterministic RED at the failing owner, fixed, mutants caught | `expo-two-way-audio-native-absence.test.ts`, P11-M1..M4 | MET |
| 3 | Fixed APK opens a paired-host session on the real phone | Owner, 2026-10-27 ~10:40 (PHYSICAL DEVICE, OWNER-OBSERVED): installed the staged APK as an update, opened host > Orca X session without a close, and typed into this Claude Code pane from it. Host corroboration: the device was last seen 2026-10-27T09:40:31Z on the installed Orca X. No logcat for this run (Wireless debugging was off after the network change). | MET (owner-observed, not instrumented) |

## Device and binary (REAL DEVICE, Owner's phone)
- Samsung Galaxy S25 Ultra SM-S938B, Android 16, adb over Wi-Fi (Samsung's ADB USB driver absent on the laptop).
- Installed app: `com.stably.orca.mobile` 0.0.43 (versionCode 12), installed 2026-09-14 by the package installer (sideloaded APK), built outside a git checkout (`NO_SUPPORTED_VCS_FOUND`), signed with the public React Native template debug key (SHA-1 5E:8F:16:06:…:F6:25).
- Host: the Owner's Orca X 1.4.178 on this laptop, reached over Tailscale 100.109.24.4:6768, then migrated to relay.

## Crash (logcat cleared 00:15:09, Owner tapped the Orca X session)
```
00:15:30.903 E ReactNativeJS: [Error: Cannot find native module 'ExpoTwoWayAudio']
00:15:30.909 E AndroidRuntime: FATAL EXCEPTION: mqt_v_native … JavascriptException
  requireNativeModule ← metroRequire ×5 ← loadRoute ← getQualifiedRouteComponent ← SceneView
00:15:30.911 W ActivityTaskManager: Force finishing activity com.stably.orca.mobile/.MainActivity
```
- Class: JavaScript exception at module evaluation, uncaught, so React Native finishes the activity. Not native, not RPC, not identity, not version skew.
- Chain: `app/h/[hostId]/session/[worktreeId].tsx` → `src/hooks/use-mobile-dictation.ts` → `@orca/expo-two-way-audio` → `core.ts`/`events.ts` → `ExpoTwoWayAudioModule.ts:5 requireNativeModule('ExpoTwoWayAudio')`.
- Binary proof: the APK's `index.android.bundle` names `ExpoTwoWayAudio` twice; none of its 4 dex files carries the name or any `expo.modules.twowayaudio` class. The module was never linked into that build; the source package and its `expo-module.config.json` are correct since 2026-05-14.
- No other gap: all 40 other native modules the JS names are present in that dex.

## Fix (328971c74) and containment (a8d7bfca2)
- The package uses `requireOptionalNativeModule`, exposes `isExpoTwoWayAudioAvailable()`, and every native call throws `ExpoTwoWayAudioUnavailableError` only when called.
- `useMobileDictation` models the absence: `available: false`, no native subscriptions, no `tearDown`, and `start()` refuses with "Dictation is not available in this app build" before leaving `idle`.
- Root and host-group layouts export expo-router's `ErrorBoundary` (`RouteErrorFallback`: message, logged correlation id, Try again, Back). A route that throws at module load has no boundary of its own, so the group layout carries it. Last resort only.

## Tests (GEX44, disposable root)
- RED on HEAD ed05a871b: 5/5 failed; the main case failed with the device error and the same `ExpoTwoWayAudioModule.ts:5 ← core.ts:2` chain.
- GREEN: `src/hooks/` 49/49; `src/hooks src/session src/terminal` 1682 passed, 1 failed, 13 files failed — identical to the pristine-HEAD baseline (missing `*.generated` under `--ignore-scripts`, and `quick-commands.test.ts`).
- Mutants P11-M1 (required module again), M2 (mic listener unguarded), M3 (start without up-front refusal), M4 (unmount tears down a missing module): each PLANT_CONFIRMED, CAUGHT, RESTORE_VERIFIED. M3 first SURVIVED (start ran outside `act`); the test was fixed, not the mutant.
- `tsc --noEmit` mobile: only the two pre-existing `*.generated` errors. oxfmt/oxlint clean on touched files.

## Build gate (2a4f2ef6d)
`node scripts/audit-apk-native-modules.mjs <apk>` fails when the bundle names a native module the JS requires and the dex lacks.
- Owner's 0.0.43 APK with pre-fix sources: `CRASH_AT_IMPORT ExpoTwoWayAudio`, exit 1 (41 names).
- Same APK with fixed sources: `optional-absent`, exit 0.
- New APK (a8d7bfca2): exit 0; Expo autolinking listed `orca-expo-two-way-audio (0.1.0)`.
- Not yet wired into a CI workflow (no mobile APK job exists on this branch).

## New APK
Built on GEX44 from a8d7bfca2: `expo prebuild` + `assembleRelease` (arm64-v8a), 59,337,436 bytes, sha256 ca68faa3…21df, same template debug certificate as the installed APK. Build-environment patches (disposable tree only): `foojay-resolver-convention` 0.5.0 → 1.0.0 in `@react-native/gradle-plugin` (0.5.0 fails on Gradle 9: `JvmVendorSpec … IBM_SEMERU`), and a user-space Temurin JDK 17 (GEX44's Java 21 has no `javac`).

## Not proven
- The P0 done-gate (session opens on the phone), the failure matrix, fresh output from the phone, reconnect, foreground and revocation on the new build: all owed after the Owner installs.
- Why the September build missed the module is UNKNOWN (no VCS info in the APK); the gate now catches the result whatever the cause.
