---
phase: 20-off-lan-wake-oob-boundary-and-institutional-close-m3-m4
reviewed: 2026-10-28T00:00:00Z
depth: standard
diff_range: 608a536fa..HEAD
files_reviewed: 16
files_reviewed_list:
  - src/main/runtime/host-oob-probe.ts
  - src/main/runtime/host-oob-verdict.ts
  - src/main/runtime/oob-power.ts
  - src/main/runtime/oob-power-test-double.ts
  - src/main/runtime/host-availability-producer.ts
  - src/main/index.ts
  - src/shared/host-wake-proxy.ts
  - src/shared/windows-system-tool-path.ts
  - src/shared/secure-path-windows-acl.ts
  - config/scripts/host-capability-producer-gate.mjs
  - config/scripts/check-host-card-claims.mjs
  - config/host-card-claims.jsonc
  - src/main/runtime/relay/loopback-relay-cell.ts
  - src/main/runtime/wake-broker-relay-test-harness.ts
  - docs/reference/host-wake-broker.md
  - AGENTS.md
findings:
  critical: 0
  warning: 3
  info: 4
  total: 7
status: issues_found
fix_status: warnings_fixed
fixed: [WR-01, WR-02, WR-03, IN-02]
deferred: [IN-01, IN-03, IN-04]
---

# Phase 20: Code Review Report

**Reviewed:** 2026-10-28
**Depth:** standard
**Files Reviewed:** 16 (and test siblings, read only to judge whether they can fail)
**Status:** issues_found

## Summary

The runtime pieces hold up. The OOB probe spawns argv-only, through absolute paths (System32 PowerShell, `/usr/sbin/sysctl`). It is single-flight, bounded to one read per 10 minutes, and every failure path lands on `unknown` (`oob_probe_unreadable` or `oob_probe_pending`). The verdict has no `supported` branch. The test double is reachable only from `oob-power.test.ts`, and the sweep that proves it walks all of `src` with station and positive controls. `composeWakeProxyAvailability` accepts only answers from the current session and keeps every other input `unknown`, each with a named reason. The `secure-path-windows-acl.ts` refactor preserves its behaviour: the extracted helper is byte-equivalent and still reads `process.env` at call time. The `index.ts` hunks only register the probe and start the first read.

There are no blockers. The main defect is in G6. AGENTS.md and the doc say G6 "enforces" that no capability reads `supported` without an evidence producer, but G6 scans a classified file or function, not the code that actually puts the value on the wire. Several modules that emit capability values are never scanned, so a `supported` literal placed there passes the gate. The other two warnings are a definitive `not-supported` claim that rests on the CPU vendor alone, and a test harness that leaks a module singleton and open sockets when setup fails partway.

## Warnings

### WR-01: G6 scans the classified verdict file, not the module that emits the value, so `supported` can bypass it through the probe wrappers

**File:** `config/host-card-claims.jsonc:174-178` (and 156-170), `config/scripts/host-capability-producer-gate.mjs:76-94`, `src/main/runtime/host-availability-producer.ts:108`, `src/main/runtime/host-oob-probe.ts:37-41,120-124,130`, `src/main/runtime/host-wol-probe.ts:35,160,169`, `src/main/runtime/host-autostart-probe.ts:95-103`

**Issue:** G6 resolves `producer` to a single file or function region and tests only that text with `SUPPORTED_LITERAL`. The value that reaches the wire comes from a different place: `'can-power-on-oob': sources?.oob.read() ?? ...` (host-availability-producer.ts:108) returns the probe's `cached` value. The probe has its own capability literals (host-oob-probe.ts:37-41 `UNREADABLE`, :120-124 the platform default, :130 `pending`), and so does the WOL probe (host-wol-probe.ts:35, 160, 169). In the autostart probe, `offWindowsCapability` (host-autostart-probe.ts:95-103) emits `not-supported` outside the classified region `capabilityFromStatus`. None of these is ever read by G6, and neither is the `describe()` composition that selects the source.

**Scenario:** someone edits `readDarwin` in `host-oob-probe.ts` to `return { value: 'supported', reason: 'x', evidence: { kind: 'os-probe', observedAt: deps.now() } }`, or changes the `default:` branch at :120 the same way. The result:
- `host-oob-verdict.ts` is unchanged, so R5 sees no supported literal and R6 sees nothing stale.
- `pnpm check:host-card-claims` passes.
- `status.get` announces `can-power-on-oob: supported`.

The same holds for `host-wol-probe.ts` against the `can-wake-lan` pin. AGENTS.md:129 ("never read `supported` without an evidence producer, and `pnpm check:host-card-claims` (G6) enforces it") and docs/reference/host-wake-broker.md:106-110 therefore overstate the guarantee.

**Why existing guards miss it:** mutant P20-O1 (20-04-PLAN.md:188) mutates only the verdict file, the one place G6 does scan. No mutant targets the wrapper. The unit tests pin today's values but are not a ratchet against a new branch.

**Fix:** extend each `hostCapabilities` entry with the wiring modules that can emit its value, and scan them all. For example, `"emitters": ["src/main/runtime/host-oob-probe.ts"]`, evaluated with the same R5/R6 rules. Alternatively, add a structural check that the `describe()` line for each id calls only a classified producer:

```js
// R7 wiring: every module that the capability's describe() line reaches must be scanned by R5.
for (const file of entry.emitters ?? []) {
  const region = stripComments(read(file) ?? '')
  if (SUPPORTED_LITERAL.test(region) && entry.supported === null) {
    failures.push(`capability ${id}: ${file} emits supported without an evidence producer`)
  }
}
```

Add a mutant that injects `value: 'supported'` into `host-oob-probe.ts`, and require it to go red. Until then, reword AGENTS.md:129 and the doc to "the classified producer may not emit supported".

### WR-02: Any AuthenticAMD host gets a definitive `not-supported` for `can-power-on-oob`, but AMD hosts can have out-of-band power control

**File:** `src/main/runtime/host-oob-verdict.ts:45-52`

**Issue:** The verdict reduces "can this host be powered on out of band" to "is the CPU Intel", because AMT is Intel-only. The capability id is the generic `can-power-on-oob`, though, and the value is a positive negative claim with `os-probe` evidence. That claim is false for common AMD hosts:
- AMD PRO desktops and laptops with DASH manageability (out-of-band power-on through the NIC).
- EPYC and Threadripper servers and workstations with an IPMI/Redfish BMC.
- Linux VMs, whose `/proc/cpuinfo` reports the hypervisor host's vendor while the hypervisor holds power control.

D-07 recorded `HARDWARE_BOUND` for *this* AMD board. The code applies it to every AMD host Orca runs on.

**Scenario:** Orca serve runs on an EPYC server with a BMC, or on a Ryzen PRO desktop with DASH enabled. `/proc/cpuinfo` or Win32_Processor reports `AuthenticAMD`, so `status.get` announces `not-supported / hardware_bound_amd_no_amt` with `os-probe` evidence. The phone renders the host's own measured statement that OOB power-on is impossible, which the probe never measured. Project rules forbid this: Workspace Surface Claims require a value to come from an owner, and a claim must match what its producer can prove.

**Fix:** keep the AMD finding but stop claiming impossibility. Either:
- return `unknown` with reason `amd_no_amt_other_oob_unverified`, or
- narrow the claim to its evidence by renaming the reason and adding a `hardware_bound` meaning that the classification `why` (host-card-claims.jsonc:120, 177) states explicitly as "no AMT" and not "no OOB".

If the product decision really is "AMT is the only OOB path Orca will ever drive", record that scope in the doc. In that case `not-supported` means "not supported by Orca", and the doc's "AMD board has no out-of-band power controller to reach" (verdict comment at line 46) should be corrected.

### WR-03: The relay wake harness leaks the wake-broker singleton, the RPC server and the temp dir when setup fails or `close()` throws partway

**File:** `src/main/runtime/wake-broker-relay-test-harness.ts:164-211, 254-264`; `src/main/runtime/wake-broker-relay-dispatch.test.ts:15-19, 41`

**Issue:** `startRelayWakeHarness` does three things before it returns the handle that `afterEach` uses for cleanup: it starts the `OrcaRuntimeRpcServer` (a WebSocket listener) at :172, enables the module-global `wakeBrokerHost` at :202, and starts the relay cell and transport at :208-211. A throw anywhere after :172 leaves `harness` undefined in the test, so nothing is stopped:
- `server.start()` stays listening,
- `wakeBrokerHost` stays enabled with its device authority attached,
- the cell stays open,
- `mkdtemp` stays on disk.

`close()` runs its steps sequentially without `try/finally`. If `transport.stop()` rejects, the cell and server are never closed, and `wakeBrokerHost.disable()` and `attachDeviceAuthority(null)` never run.

**Scenario:** a regression makes `startWakeBroker` return `targetCount: 0`, so :203 throws. The broker singleton stays enabled for every later test in the same vitest worker, and the open WebSocket server keeps the worker alive. One real failure turns into cascading wrong-state assertions or a hung run. That makes the harness unreliable exactly when it is needed for diagnosis.

**Fix:** collect teardowns as resources are acquired, and unwind them on a setup throw and in `close()`:

```ts
const teardown: Array<() => Promise<void> | void> = []
try {
  await server.start(); teardown.push(() => server.stop())
  // ... startWakeBroker(...); teardown.push(() => { wakeBrokerHost.disable(); wakeBrokerHost.attachDeviceAuthority(null) })
  // ... cell, transport likewise
} catch (error) {
  await unwind(teardown); throw error
}
// close(): await unwind(teardown) where unwind runs every step in reverse inside try/finally
```

## Info

### IN-01: G6 evidence and literal matching is looser than the config header promises

**File:** `config/scripts/host-capability-producer-gate.mjs:20, 107`; `config/scripts/check-host-card-claims.mjs:203-206`; `config/host-card-claims.jsonc:19-20`

**Issue:** The header says an allowance names the evidence kinds "that producer quotes **beside** its supported value". R5 only checks that the kind is quoted *anywhere* in the region (`new RegExp(['"]${kind}['"]).test(region)`). Inside `capabilityFromStatus`, a new `{ value: 'supported', evidence: null }` branch would pass, because `'os-probe'` is already quoted at the `evidence` const. There are further gaps:
- `stripComments` blanks only whole-line `//` comments, so a trailing `// 'os-probe'` also satisfies R5.
- The block-comment regex does not know about strings, so a string literal containing `/*` (a glob such as `'src/**/*.ts'`) blanks code up to the next `*/`, which can hide a literal.
- `SUPPORTED_LITERAL` does not match template-literal, constant (`value: SUPPORTED`) or quoted-key (`'value': 'supported'`) forms.

**Fix:** either correct the header to "quotes somewhere in the region", or tighten R5 to require the kind within the same object literal as the supported value. Strip trailing comments with a string-aware tokenizer, for example the `stringLiterals` helper already imported from check-workspace-surface-claims.mjs. Add the backtick form to `SUPPORTED_LITERAL`.

### IN-02: A stale classification `why` for the `can-power-on-oob` label

**File:** `config/host-card-claims.jsonc:98`

**Issue:** "no producer can prove it yet, so it reads unknown" was true in phase 18. Since 20-02, AMD hosts read `not-supported` from the OOB probe, and line 120 of the same file says so. The two `why` texts contradict each other.

**Fix:** reword it to "Naming out-of-band power-on is not offering it; the OOB probe never reads supported (unknown on Intel, not-supported on AMD)".

### IN-03: The loopback relay cell admits a host leg with no ticket, and can throw from a listener

**File:** `src/main/runtime/relay/loopback-relay-cell.ts:41, 62-63`

**Issue:** This is test-only, but three things can mislead a future refusal test or crash the worker:
- `auth.connTicket === tickets.get(connId)` is `undefined === undefined` for an unregistered connId and an auth frame without `connTicket`, so the leg is admitted.
- `decodeURIComponent` throws `URIError` on a malformed path inside a `'message'` listener, which becomes an uncaught exception.
- No `'error'` listener is attached before `'listening'`, so a listen failure crashes instead of rejecting.

**Fix:** require `typeof auth.connTicket === 'string' && tickets.has(connId)`, wrap the decode, and race `'listening'` against `'error'`.

### IN-04: `getWindowsSystemToolPath` does not check that the root is absolute

**File:** `src/shared/windows-system-tool-path.ts:8-9`

**Issue:** The guarantee "never resolved through PATH" holds. However, a relative `SystemRoot` or `WINDIR` in a sanitized or hostile environment yields a cwd-relative executable path. Nothing then spawns from System32, which is the guarantee the comment states. The test pins only the default and unset cases.

**Fix:** fall back to `C:\Windows` unless `pathWin32.isAbsolute(systemRoot)`, and add a row with `SystemRoot: 'Windows'`.

## Fix Log

Applied 2026-10-28 in `C:\owx-haf` (branch `mobile/host-availability`); every gate and test below ran in this worktree, on
the laptop. RED was committed before GREEN for each warning. Nothing was pushed.

| Finding | RED | GREEN | Evidence |
|---|---|---|---|
| WR-01 | `40638e4ef` | `26ded4032` | G6 R7: each `hostCapabilities` entry lists `emitters` (`host-oob-probe.ts`, `host-wol-probe.ts`, `host-autostart-probe.ts`; `[]` for the three producers `describe()` calls directly), scanned under the same supported rule; a missing `emitters` key fails. RED: `can-wake-lan: expected [] to deeply equal [ Array(1) ]` (a planted probe literal passed). GREEN: `vitest run config/scripts/host-capability-producer-gate.test.mjs config/scripts/check-host-card-claims.test.mjs` -> `Tests  53 passed (53)`. Real-tree mutant P20-O3 (supported in `readDarwin`): exit 1, `- capability can-power-on-oob: emitter src/main/runtime/host-oob-probe.ts emits supported without an evidence producer`; restored by byte copy, sha256 `403A1DB1...2141` equal, gate exit 0 (20-04-MUTANTS.md). AGENTS.md:129's "G6 enforces it" is now true and is unchanged. |
| WR-02 | `570fd0761` | `1f857dab1` | AuthenticAMD now reads `unknown / amd_no_amt_oob_unmeasured`, evidence `null` (the WOL-verdict precedent for unknown). GREEN: verdict, probe, producer, status and `src/shared/host-availability.test.ts` -> `Tests  107 passed (107)`. Read-only live leg re-run with `ORCA_LIVE_OOB_PROBE=1`: `Tests  1 passed (1)`, evidence `{"value":"unknown","reason":"amd_no_amt_oob_unmeasured","evidence":null}`, vendor `AuthenticAMD`, meiCount `0` (the earlier run is kept as historical in 20-VERIFICATION.md). M4 stays HARDWARE_BOUND as a verification label: AMD B450M consumer board, no AMT. The parser fixture in `src/shared/host-availability.test.ts` keeps `not-supported / hardware_bound_amd_no_amt`, because an old host can still announce it. |
| WR-03 | `4f5d15e62` | `2dac82c2a` | The harness registers a teardown per acquired resource and unwinds in reverse on a setup throw; `close()` runs every step and raises an `AggregateError`. RED: `expected "stop" to be called 1 times, but got 0 times`. GREEN: `vitest run src/main/runtime/wake-broker-relay-test-harness.test.ts src/main/runtime/wake-broker-relay-dispatch.test.ts` -> `Tests  10 passed (10)`. |
| IN-02 | (none: wording only) | `8aeb8140a` | The `capability.can-power-on-oob` `why` now says the probe never reads supported and reads unknown on Intel and AMD. |

Gates after the last fix: `typecheck:node` exit 0, `typecheck:web` exit 0, `check:recurring-work` `total=236 ... debt=0`,
`check:durability-contracts` passed (22 contracts, no new ones), and `check:host-card-claims`:
`check-host-card-claims: 22 labels classified, 2 controls classified, 598 host RPC methods known, no unevidenced power-loss state, no control without an effect, 6 capability producers classified, 3 capability emitters scanned.`

Deferred, untouched: **IN-01** (G6 literal and evidence matching looser than the header), **IN-03** (loopback relay
cell ticket and listener robustness) and **IN-04** (`getWindowsSystemToolPath` absolute-root check).

---

_Reviewed: 2026-10-28_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
