# Phase 5: Composer, copy and paste, visual Product Reality - Context

**Gathered:** 2026-10-26
**Status:** Ready for planning
**Mode:** Autonomous smart-discuss (unattended; recommended option taken)

<domain>
## Phase Boundary
The compact mobile terminal is real: one bottom command textbox, Copy and Paste through the canonical
clipboard path, no duplicate prompt line or Terminal header, captures at target sizes in dark mode with
long names and many runtimes, pixel values from mobile-theme.ts.
</domain>

<decisions>
## Implementation Decisions
- D-01 Split by plane. Behaviour (paste, copy path, composer and header inventory, token sourcing) is
  proven here. Captures need a rendered app: the previous captures used an Android 14 emulator
  (visual-asset-registry r05 notes); none is reachable from this worker.
- D-02 Canonical clipboard = expo-clipboard (`setStringAsync` copy at session screen :3558;
  `getStringAsync`/`getImageAsync` paste in use-mobile-terminal-paste.ts). The OS owns the paste
  permission prompt; Orca adds none.
- D-03 Emulator on GEX44 refused: /dev/kvm is root:kvm and kobii is not in group kvm; no Android SDK.
  Joining kvm needs root on a shared host, so it is not attempted (outward, not cheaply undoable).
</decisions>
