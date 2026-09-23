# ChatGPT Android — Reference Matrix

Measured from the Owner's screen recording. This sheet is the evidence base for Personality A
(conversation) — Brainstorming, direct agent chat, Council. It records **what the recording
proves**, what it does not, and how each number was obtained.

## Provenance

| | |
|---|---|
| Source | `Screen_Recording_20260920_162714_ChatGPT.mp4` (Owner-supplied, not in this repo) |
| SHA-256 | `4B8940E584F17DE23F1B90256681DD35E3D5DE295478555BD1796B37722BF1D2` |
| Size / duration | 164.8 MB · 148.476 s |
| Capture | 1080 × 2340, 120 fps, portrait. Android, One UI three-button nav, Spanish locale |
| Subject | ChatGPT Android app, dark theme, inside one conversation titled *Claude Power Pack* |
| Method | `ffmpeg` survey pass at 1 frame / 5 s (30 frames, scaled 720w) for the flow; **geometry measured on native 1080-wide frames** decoded to raw RGB24 and sampled per pixel, never on a scaled image |

## What the recording evidences

The app has **no persistent chrome**. There is one scrolling content plane; the back
button, the title, the overflow button, the attachment chip and the composer all **float over
it**, and conversation text is visible running underneath each of them. This is the single most
transferable observation: the surface is content, and controls are guests on it.

### Message asymmetry — the core of the personality

| | User | Assistant |
|---|---|---|
| Container | filled bubble | **none** — bare prose on the canvas |
| Alignment | right | full width |
| Width | 766 px fill (≈ 71 % of 1080) | edge-to-edge within the content gutter |
| Fill | `#133262` (dark navy, essentially flat) | canvas |

Between a user turn and the assistant's answer sits a **reasoning disclosure row** —
`Ha pensado durante 21s ›` — grey, small, with a trailing chevron, tappable. It is a row, not a
card, and it carries a duration rather than a spinner.

Assistant prose mixes weights freely (bold for emphasis inside paragraphs), renders inline
**monospace** for code identifiers such as `modules/decision_review/decision_record.py`, and uses
small-dot bullets. Long ASCII rules (`====`) wrap rather than scroll.

### Composer states, in the order they appear

1. **Idle** — hint text *"Responder a ChatGPT"*, `+` at the left, microphone and a **blue circular
   voice-mode button** at the right.
2. **Focused, short** — the blue voice button is **replaced by a blue circular send arrow ↑**, and
   a blue **gauge/dial control** appears between the text and the microphone.
3. **Focused, grown** — once the draft passes roughly four lines, an **expand affordance (⤢)**
   appears to the left of the gauge. The composer grows upward; the conversation does not reflow,
   it is simply covered.
4. **Text selected** — the platform's own selection bar (Cortar · Copiar · Pegar · Pregunta a
   Gemini · ⋮) floats above the composer. Worth noting only because it is OS chrome, not app
   chrome, and a reference must not reproduce it.

### Measured geometry (native px, 1080 × 2340; dp assumes density 3.0)

| Element | Measurement | px | dp |
|---|---|---|---|
| Composer | left inset | 32 | 10.7 |
| Composer | right inset | 32 | 10.7 |
| Composer | width | 1016 | 339 |
| Composer | height (idle) | 216 | 72 |
| Composer | fill | `#202020` | — |
| Composer | corner radius | **26–40 (instrument-limited)** | 9–13 |
| Header chip (back) | diameter | 116 | 38.7 |
| Header chip | left inset | 37 | 12.3 |
| Header chip | right inset (overflow) | 37 | 12.3 |
| Header chip | fill | `#1f1f1f` | — |
| Header chip | top inset | 128 | 42.7 |
| User bubble | fill width | 766 | 255 |
| User bubble | right inset | 43 | 14.3 |
| User bubble | fill | `#133262` | — |

**On the radius.** Two derivations disagree: the topmost row's horizontal inset gives ≈ 26 px, and
the depth at which the left edge reaches full extent gives ≈ 40 px. Video compression and
antialiasing blur the corner, so the honest answer is a range. Do not pick one and cite it as
measured.

**Instrument note.** An earlier pass reported a composer height of 461 px and a back-chip span of
264 px. Both were **saturated** — the scan column crossed the user bubble, and the row bound cut
through the title text, so each probe returned its own scan range. The corrected probes sample a
column at x=60 (inside the composer, left of the bubble) and bound the chip row well clear of the
title, and they report a `SATURATED` flag so a bounded read can never again be mistaken for a
measurement.

## What the recording does NOT evidence

The recording never leaves the conversation. It therefore says **nothing** about:

- the navigation drawer, and so nothing about *Nuevo chat · Agentes · Biblioteca · Programadas ·
  Complementos · Más · Proyectos · Chats* — that list comes from the brief, not from this file;
- the new-chat empty state;
- the projects list or a project's own surface;
- the model picker;
- **streaming** — every assistant message in frame is already complete;
- any light theme;
- any tablet or desktop layout.

Those states remain **unevidenced**, and a reference built for them is `truth: target`, not
`current`. W2 (global shell) is not unblocked by this recording; W3 (conversation) is.

## The Owner's own brief, transcribed from the recording

The draft being typed on screen at 16:26–16:27 states the intent directly, and it is more precise
than any paraphrase:

> *"lo que te estoy enseñando es cómo quiero que sea un apartado de Orca X que sea de
> brainstorming, que sea un chatgpt exacto (puedes basarte en el repo de plantgpt) con proyectos y
> todo conectado a mi red de workspaces y a donde lo quiera mandar, y pueda hacer brainstorming
> exactamente con la misma experiencia que en chatgpt, pero conectado a todos mis archivos y con
> contexto y todo, y que me conteste Codex CLI en el mismo formato de mensaje largo"*

Two things follow. The target is **experience parity, not pixel parity** — "la misma experiencia".
And the answering agent is **Codex CLI rendering long-form**, which is exactly the assistant-prose
treatment measured above: no bubble, full width, mixed weights, inline monospace.

The PlantGPT repository is named as a permitted *basis*. Numbers from it may be cited; **no
PlantGPT file, asset or snippet may enter this repository** — it is AGPL-3.0 and Orca X is MIT.

## What this means for Orca

| Observation | Consequence for the Orca surface |
|---|---|
| No persistent chrome; controls float | Brainstorming should not inherit the workspace's chrome. Content is the surface. |
| Assistant prose is uncontained | Do not render assistant turns in a card. Orca's existing NativeChat renderer is reused, not forked. |
| User turn is a contained tinted bubble | One tinted container, right-aligned, ~70 % max width. Uses a token, not `#133262` — the *role* transfers, the hex does not. |
| Reasoning is a row carrying a duration | Matches Orca's existing thinking treatment; a row, never a modal, never a spinner alone. |
| Composer grows and covers | The conversation does not reflow around the composer. |
| Send button replaces voice button on input | One slot, two states — not two buttons. |

The hexes above are **evidence of the source app**, not tokens to copy. Orca's canonical values
live in `src/renderer/src/assets/main.css`, and the constitution maps each role onto a token there.
