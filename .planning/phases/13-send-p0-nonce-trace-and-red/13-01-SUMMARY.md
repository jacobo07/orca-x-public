---
phase: 13
plan: 01
status: complete
completed: 2026-10-27
key_files:
  - mobile/src/session/mobile-native-chat-send-admission.test.ts
  - src/main/runtime/mobile-agent-send-admission.live.test.ts
---

# Plan 13-01 summary

A phone chat message longer than ~60-90 characters never becomes a Claude Code turn on a Windows host. The phone
bundles Ctrl+U with the body in one write. Claude Code takes that burst as a paste, and ignores the Enter that follows 500 ms later. The host reports the
write as accepted, and the phone shows it as sent. Measured on three planes: the Owner's installed app, a direct ConPTY harness, and a real Orca serve host with a
scripted phone. Each negative has an admitted control in the same run. Of H1-H5, H1 is confirmed (refined) and the rest are rejected. A deterministic RED
at `mobile-native-chat-send.ts` and a live "the agent turn exists" RED are committed. Details: 13-VERIFICATION.md.

Deviations: the trace ran on a disposable serve host, not the Owner's installed app, because pairing the installed app needs a UI click.
The Owner's real message was replaced in committed artifacts by a synthetic message of the same shape (privacy), which reproduces identically.
