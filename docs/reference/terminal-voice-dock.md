# Terminal Voice Dock

How Orca offers voice dictation on a terminal pane, and why it is built where it is.

## The constraint that decides the design

A terminal pane renders an opaque byte stream. The prompt a user sees — including an agent TUI's
input box and its status row — is PTY-owned character cells, not markup. Orca cannot place a DOM
control "inside" it, and must not draw one that pretends to be part of it.

So the dock integrates at the **nearest surface Orca actually owns**: the per-pane chrome layer that
already floats above xterm, is positioned from measured pane geometry, and hosts the pane title and
its action cluster. Anchoring to pane geometry rather than to PTY text also means the dock survives
an agent changing its own character-cell layout.

## Occlusion and PTY geometry

Chrome that covers terminal rows hides output. The established rule in this repo is that chrome
owning a strip is paired with a matching reduction of the terminal container's height, so no row is
ever hidden — the pane title does this at the top, and a CSS test pins the reduction against the
reservation. The dock follows the same contract at the bottom.

A visually correct dock over a PTY that still believes it owns the old row count is a functional
bug, so the reservation must flow through the canonical re-fit path.

## Reserved geometry is not visible affordance

These are separate concerns, and collapsing them causes resize churn.

If the reserved strip existed only on the focused pane, every focus change would resize that pane's
PTY. So **reservation is stable** for a voice-capable pane, while the **control's visibility** may
be gated to the active pane. Ownership of a running voice job is a third, independent thing: it
belongs to the target that started it and does not move when focus, tab, or window does.

## What the dock does and does not do

It starts and stops a dictation job. It never delivers a transcript.

Delivery stays with the existing insertion path, which captures its target at job start, fences
stale results, and retains a transcript no foreground pane claimed until the owning tab returns.
A second insertion path would defeat all three properties.

Transcription produces text; it does not authorize execution. Nothing the dock does may submit
terminal input.

## Provider boundary

Transcription runs locally by default. The provider is a property of the selected model, cloud
models require an explicitly stored credential, and there is no fallback between them — a local
failure fails, it does not silently become a network request. The dock surfaces which boundary is
active rather than hiding it.

## Acceptance

- A voice-capable terminal pane offers a keyboard-reachable dictation control with an accessible
  name, whose recording state is not carried by colour alone.
- Terminal rows stay consistent with the reserved height across pane and window resize.
- No legitimate terminal output is occluded at short, long, multiline, scrolled, or narrow states.
- In splits, exactly one pane owns the affordance and the target is unambiguous before recording.
- A transcript reaches the terminal that started the job, is editable, and is never auto-submitted.
- Local transcription succeeds with no cloud credential configured.

## Rollback

The dock is additive and gated. Disabling the feature removes both the control and its reservation,
returning the pane to its previous geometry; no persisted state changes shape.
