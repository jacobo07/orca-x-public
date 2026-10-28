---
phase: 14
plan: 01
status: complete
---

# 14-01 summary

- Fix: the phone's chat send clears the input line as its own write before the body (4e00f6e22). A long
  message (>=94 chars) becomes a Claude Code turn again. This needs no host change.
- Evidence bubble (a07d1d195): a pending bubble reads "Sent to the terminal · waiting for the agent" and,
  after 20 s with no transcript echo, turns amber: "Agent has not shown this message · check the desktop
  before resending". The transcript turn replaces it once the agent admits the message.
- Live test retargeted to the phone's real shape.
- Residual for phase 15: show the refusal reason instead of a generic "Message not sent".
- Owner action to get the fix on the phone: a new APK build from this branch (phase 16 device leg).
