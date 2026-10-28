# Backlog intake: control a live Orca X session from the phone (2026-10-26)

Owner request (verbatim intent): control Orca X sessions running on any of the Owner's computers from the phone, through the terminal, then converge with DWS / Host Fabric.

## Items
1. Prove the existing mobile RPC path against a live laptop PTY with a fresh-output oracle (nonce typed in the bottom command box, output fresh after the action, reconnect without a duplicate PTY, revocation enforced at mutation time, wrong host/runtime refused).
2. Host selector backed by the real host registry; runtime selector with real producers; unknown stays UNKNOWN.
3. Single bottom composer with Copy / Paste / Ctrl / Esc / Tab / arrows.
4. Agent prompt path through the canonical conversation owner.
5. DWS reconciliation: rows 33, 39, 59, 70, 73, 75; units X05, X06, X16, X18, X19.
6. Two-host Product Reality (Windows + GEX44 + phone), then "Continue here".

## Where it lives
- Plan: `.planning/ROADMAP.md` (10 phases) and `.planning/STATE.md` on branch `mobile/phone-control` (base rb-live c1f33f4d4e).
- Visual reference: `docs/visual/generated/terminal/terminal.session.mobile.at-rest.r01.png` on rb-live (registry `config/visual-asset-registry.jsonc`).

## Status
Planned and approved by the Owner on 2026-10-26. Ralph mission NOT armed: the preflight refused (available RAM below the 3000 MB floor). Not written to the InfinityOps `orca_intent_relay` table (production, drained by the Universal Backlog program).
