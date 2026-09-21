# Orca X Visual Reference Corpus

Canonical visual references for Orca surfaces, so a screen can be implemented without
inventing its visual behaviour.

The rules for *what* a surface may look like live in [`../STYLEGUIDE.md`](../STYLEGUIDE.md) and
the tokens live in `src/renderer/src/assets/main.css`. Neither is replaced here. This tree holds
the *pictures* those rules produce, and the index that makes each one traceable.

## Layout

| Path | Holds |
|---|---|
| `references/<surface>/` | canonical reference images, one file per slot revision |
| `generated/<surface>/` | image-model mockups kept as design lineage, never shipped as the reference |
| `sheets/` | token, typography, geometry and status-semantics sheets |
| `anatomy/` | component anatomy sheets |
| `storyboards/` | multi-frame interaction flows |

The index is [`config/visual-asset-registry.jsonc`](../../config/visual-asset-registry.jsonc),
beside the repo's other manifests. `pnpm check:visual-assets` enforces it.

## The two things the registry exists to police

**An approved reference is immutable.** People implement from these images, so the bytes must not
move under them. The registry pins every file's `sha256`; changing an approved image fails the
gate, and the way forward is to publish the next revision (`.r02.`) as a candidate and let the
predecessor become `superseded`. Status lives only in the registry — never in a filename.

**A picture of a surface Orca does not have yet is not evidence that it has one.** Every asset
declares `truth`:

- `current` — observed pixels, captured from the running app
- `target` — designed intent for a surface on the roadmap, carrying a visible TARGET label

A `target` asset must set `targetLabel: true`, and a `current` asset must not. The gate refuses
both mistakes, because an unlabelled mockup read as a screenshot is a claim that a capability
exists.

## Naming

```
<surface>.<subsurface>.<device>.<state>.r<NN>.png
shell.sidebar.desktop.default.r01.png
```

The record must agree with every segment of its own filename, so an asset cannot be filed under
a slot its name contradicts — the slot is what an implementer searches by.

## Producing an asset

Image generation is for **ideation** — composition, direction, states that are hard to describe.
What it actually does, and the several things about it that are not what they look like, are in
[`codex-image-generation-contract.md`](./codex-image-generation-contract.md): a refusal message
and a successful generation are the same text, so the artifact is confirmed with
`pnpm discover:generated-images` and never from the agent's prose.

A surface that exists is **captured** from the real app, extending the `@visual-corpus`
Playwright rig in `tests/e2e/workspace-chrome-visual-corpus.spec.ts`. A surface that does not
exist yet is built as token-true HTML that imports the same `main.css` and is rendered in the
same browser engine. Both paths end in the same screenshot, directory and registry entry — which
is what keeps the corpus coherent rather than a folder of unrelated pictures.
