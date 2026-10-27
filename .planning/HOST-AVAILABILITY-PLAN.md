# Host Availability Fabric: brief (approved 2026-10-27)

Owner approval: "Aprobado", 2026-10-27. Separate worktree `C:\owx-haf`, branch `mobile/host-availability`, based on
`c4679d615`. A different mission (SEND-P0, `m-aae9a9c1405c`) writes `C:\owx-pc` on `mobile/phone-control`: never
write there. `C:\ox` (DWS, `orca-x/dws-rebaseline-live`) is read-only from this mission.

## End state
From a phone outside the house, a known host shows a truthful state. Where a capability exists, the phone can
start Orca, wake the machine, or power it on. Then the runtime becomes ready and a terminal works, with no
physical interaction. Where the hardware cannot do it, Orca says so.

## Reality scan (2026-10-27; evidence file:line in the session archaeology)
| Capability | State | Evidence |
|---|---|---|
| Headless runtime | EXISTS | `orca serve` = Electron main with no window: `src/cli/specs/serve.ts`, `src/main/index.ts:3334-3411`; single-instance lock shared with desktop (`src/main/startup/single-instance-lock.ts`, exit code 3) |
| UI-independent host | PARTIAL | serve survives window close, but **does not start the cloud relay**: `DesktopRelayService` is created at `index.ts:3462-3493`, after serve's `return` at 3411. Off-LAN unreachable |
| OS autostart | MISSING on Windows/macOS; Linux systemd only as docs (`docs/reference/headless-linux-server.md:167-292`) |
| Power-state model | MISSING; only `powerMonitor` resume (`createMainWindow.ts:422`, relay `ensureLive` at `index.ts:3486`) |
| Reachability | EXISTS, too coarse: mobile `ConnectionVerdict` (`mobile/src/transport/connection-health.ts:31-100`: normal/warning/unreachable/auth-failed); `MobileHostCard.tsx` |
| Capabilities | PARTIAL: `DeviceScope = 'mobile'|'runtime'` (`src/shared/runtime-types.ts:55`), `RuntimeCapability` (`protocol-version.ts:203`), Node Manifest `capabilities: string[]` (`C:\ox\src\shared\node-manifest.ts:19-48`) |
| WOL / wake broker / OOB | MISSING (code, docs, history) |
| Outbound rendezvous | PARTIAL: cloud relay dials out over `wss://<cell>/v1/host/control` (`relay-control-url.ts`), needs cloud auth, desktop mode only |
| Prepare this device | PARTIAL in `C:\ox` (`use-prepare-device-measurements.ts`, `environment-prepare-plan.ts`); no autostart, wake or availability steps |

## Hardware of the Owner's Windows host (measured 2026-10-27)
- MSI MS-7B89 desktop board, AMD platform: **no Intel AMT/vPro**.
- Wired Realtek PCIe GbE, IP 192.168.7.11. The driver has "Wake on Magic Packet" enabled, but **Windows has not
  armed it**: `powercfg /devicequery wake_armed` lists only HID keyboard/mouse.
- `powercfg /a`: S3 sleep, hibernate, hybrid sleep and Fast Startup are available. S0ix is not.
  `HiberbootEnabled=1`, i.e. Fast Startup is ON (affects wake from soft-off).
- LAN 192.168.7.0/24, router 192.168.7.1: **no always-on node** (no Pi, NAS or second server). GEX44 and the VPS are
  off-LAN.

## Decisions
1. **Host Service = `orca serve`, not a new engine.**
   - Windows autostart is a **Scheduled Task at user logon, restarted on failure**. Not a Windows Service, because
     serve needs the user session for PTYs, credentials and the provider CLIs. Not a Startup-folder hack.
   - The single-instance lock already prevents duplicates. Opening the desktop UI while serve runs must hand over
     cleanly; measure this first.
2. **serve starts the relay** (the outbound rendezvous) when cloud auth exists. Without auth, serve reports
   `relay: unavailable` and never fakes it.
3. **Three composed dimensions, not one enum:**
   - power: `awake | sleeping | hibernating | powered-off | unknown | unobservable`
   - orca: `service-ready | runtime-ready | ui-open | ui-closed | starting | version-mismatch | unavailable | unknown`
   - connectivity: extend `ConnectionVerdict`, plus `wake-proxy-available | oob-available`
   - No response is `unknown`, never `powered-off`.
4. **Capabilities are separate from state and from authority:** `can-start-orca`, `can-wake-lan`,
   `can-wake-remote`, `can-power-on-oob`, `can-relay`, `can-direct`. They are carried additively in the Node
   Manifest `capabilities[]`. That file is owned by the DWS lane in `C:\ox`: propose the additive field there,
   never fork it.
5. **Wake Broker** is a role, not a vendor: any paired Orca host on the same LAN (e.g. `orca serve --wake-broker`
   on a Raspberry Pi).
   - Phone → relay (outbound only) → broker → magic packet → the target's Host Service announces itself.
   - No public inbound ports and no public wake endpoint. MACs live on the broker, never on the phone.
6. **Grants:** `REMOTE_START_ORCA`, `REMOTE_WAKE`, `REMOTE_POWER_ON` are separate. Pairing alone does not imply
   wake. Revocation is re-checked at every effect, including at the broker. Requests carry an idempotency id, and
   the broker keeps a dedupe window.
7. **OOB:** a generic power interface with a test-double boundary only. **No AMT on this hardware**, so real OOB
   is HARDWARE_BOUND.
8. **Mobile card is a projection:**
   - It never renders `powered-off` without evidence, nor Wake/Power-on without a proven capability and grant.
   - Enforce with a presentation-table gate, in the style of `check:workspace-surface-claims`.
   - Use the existing i18n.

## Milestones and done-gates
- **M1, Orca closed:**
  - PC awake, Electron UI closed, Host Service (serve) running.
  - The phone still sees the host truthfully and can request the runtime.
  - A terminal opens, a unique command returns fresh output, and no duplicate runtime appears.
  - Fully autonomous.
- **M2, LAN wake:**
  - Host sleeping, authorized wake request, magic packet issued by the canonical owner.
  - The host wakes, the Host Service reconnects and the terminal works.
  - OWNER_BOUND on steps (a) and (b) below.
- **M3, off-LAN wake:**
  - Phone on 5G, broker in the LAN wakes the target, fresh terminal output.
  - No inbound public port.
  - OWNER_BOUND on step (c).
- **M4, powered off:**
  - HARDWARE_BOUND (no AMT), unless WOL from S5 works once Fast Startup is off. Measure that; never assume it.

## Owner-only steps (none blocks M1)
- (a) Elevated, once: `powercfg /deviceenablewake "Realtek PCIe GbE Family Controller"`.
- (b) BIOS: enable "Resume by PCI-E / LAN" and set ErP to disabled. For S5 wake, also turn Fast Startup off.
- (c) Provide an always-on LAN node for the Wake Broker (a Raspberry Pi, a NAS, or a router with WOL), or accept
  "no remote wake".

## Product Reality matrix
A awake + UI open · B awake + UI closed · C awake + runtime not running · D sleeping + same LAN · E sleeping +
phone on 5G + broker · F hibernating · G powered off, no OOB · H powered off, real OOB (HARDWARE_BOUND) · I GEX44
always-on · J VPS always-on · K broker offline · L revoked phone · M version mismatch.
Every row needs a truthful expected behaviour, and evidence labelled SCRIPTED CLIENT / REAL DEVICE /
OWNER-OBSERVED.

## Token budget
- Total ≈ 2.4 M across ~10 sessions:
  - Host Service + autostart: 0.45 M
  - Models + mobile projection: 0.4 M
  - WOL / broker / rendezvous: 0.5 M
  - Product Reality: 0.45 M
  - Security / failure / mutants: 0.25 M
  - Vault / UKDL / baseline: 0.15 M
  - Reserve: 0.2 M
- Checkpoint and relay at the 40 % wall through `/cpp-gsd-long`.

## Laws
- The machine is the node, not the UI.
- Unreachable is not powered off.
- A wake packet sent is not a host woken.
- A host awake is not a runtime ready.
- No button without a backend effect.
