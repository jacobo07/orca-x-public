# SEND-P0 Owner evidence (screenshots, 2026-10-27 15:21 local)

Files (Owner's Downloads, read them directly):
- Phone: `C:\Users\Jacobo\Downloads\Screenshot_20261027_152145_Orca X.jpg`
- Desktop photo: `C:\Users\Jacobo\Downloads\20261027_152137.jpg`

## What they show
- **Runtime:** a Claude Code agent TUI (status line "Sonnet 5.5 | Jacobo 16%", bypass permissions on).
  This is the native-chat send path, i.e. `terminal.send` into the agent PTY. It is not a separate
  conversation RPC.
- **Host and target:** phone header "Casual greeting about the drive · Host 1 · .../Cursor Projects/Jacobo",
  green dot. The desktop tab has the same title "Casual greeting ab..." in the same project.
  So the target was the right session, not the wrong host or PTY.
- **Desktop:** the phone's message (personal text, redacted for the repo: Spanish, ~140 chars, two 😂 emoji)
  sits **on the Claude Code input line
  (`>` prompt), unsubmitted**. There is no "Brewed/Crunched" turn after it. The previous phone messages
  (`y para que dijo mañana?`, done 3:06 PM, and earlier ones) were submitted normally.
- **Desktop chip:** "Teléfono controlando" with a "Recuperar control" button, so the phone held the floor.
- **Phone:** the message is rendered as a normal user bubble. It has no pending, unconfirmed or error
  indicator, and the composer was cleared.
- **Desktop status line:** `cpp-cognitive-runtime: CCR SHADOW: host 2.1.311 not in COMPAT`, an Owner
  harness warning. Check whether it is unrelated.

## Verdict on the hypotheses (from the evidence; phase 13 must still reproduce it)
- H1 (bytes land, the TUI does not submit): **CONFIRMED by observation.** The body reached the exact PTY. The
  submit `\r` either did not arrive or was not taken as submit. The first missing receipt is between the
  PTY write and turn admission, exactly as planned.
- H2 (wrong or stale PTY): REJECTED for this incident (right tab, text visible there).
- H4 (lease or floor refusal): REJECTED for this incident (the write was accepted; the phone held the floor).
- H3 (ack loss): unlikely. The bubble is not in an unconfirmed state.
- Lead for phase 13: this message contains emoji (surrogate pairs, 😂😂) and is longer than the earlier ones
  that worked. Test the body/`\r` split with emoji and length, and test Claude Code's paste/IME handling
  of the 500 ms-later `\r` (`orca-runtime.ts` writeTerminalAction). Also check for a bracketed-paste or
  input-mode state the TUI was in at that moment.
- Second defect, independent of the cause: the phone showed a "sent" bubble for a message that never
  became a turn (write receipt rendered as delivery). Phase 14 owns it.
