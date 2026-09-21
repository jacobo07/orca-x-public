# Codex Image Generation — What Is Actually True

The visual corpus uses image generation for *ideation*: composition, direction, and states that
are hard to describe in words. It is not how a canonical reference is produced — see
[`README.md`](./README.md) for the lifecycle and [`../STYLEGUIDE.md`](../STYLEGUIDE.md) for the
rules an implementer follows. This file records what the generation step itself does, because
almost every intuitive answer about it turned out to be wrong when measured.

Status: **LIVE**. Every claim below was observed on 2026-09-20/21, on this machine, with
codex-cli 0.153.4.

## The capability exists on the ChatGPT subscription

No API key, no MCP server:

```
modelProvider/capabilities/read
  -> {"namespaceTools":true,"imageGeneration":true,"webSearch":true}
```

…under `auth_mode: chatgpt` with `OPENAI_API_KEY: null`. It is a **built-in model tool** plus a
bundled skill at `<CODEX_HOME>/skills/.system/imagegen/SKILL.md`. `codex mcp add` is the wrong
mechanism: an MCP server needs its own credential and this needs none.

**How this was nearly missed, which is the reusable part.** An earlier pass concluded the
capability was absent, from `codex --help` (which shows only `-i/--image`, image *input*) and
`codex mcp list` (empty). Both answer a question about the **CLI surface**; the capability lives
on the **model tool surface**. The instrument could not have returned the other answer, so its
"absent" carried no information. The right instrument is the protocol describing itself:

```
codex app-server generate-json-schema --experimental --out <DIR>
```

then grep the bundle — with a positive control (`turn/start` must return hits, or the probe is
blind rather than the capability missing). The tell is
`UsageLimitExceededImageGenerationFailure` carrying a `limitId`: a *plan* limit is what a
subscription-backed capability fails with.

## A refusal message is not a failed generation

The imagegen skill lives outside the workspace sandbox, so a run routinely reports:

- *"policy blocked reading the imagegen skill"*
- *"read-only filesystem, no file was created"*

…**and writes the PNG anyway.** The text a successful run emits and the text a refused one emits
are the same text. Workspace write access is not required to obtain the image; it is collected
from the Codex home.

> **Never classify the outcome from the agent's prose. Read the store.**

That is not a reason to ignore real failures. Keep four states apart: a claimed failure · an
observed artifact · a valid artifact · a completed generation. Only the filesystem distinguishes
the first two, and only the PNG header distinguishes the next two.

## Where the output goes, and how to see it

`<CODEX_HOME>/generated_images/<thread-id>/exec-<uuid>.png`. `CODEX_HOME` is **discovered, never
hardcoded** — on a machine where Codex runs under Orca's managed runtime it is
`%APPDATA%/orca/codex-runtime-home/home`, and standalone it is `~/.codex`.

```
pnpm discover:generated-images                        # everything in the store
pnpm discover:generated-images -- --since <iso>       # just this turn's
pnpm discover:generated-images -- --json
```

`config/scripts/codex-generated-image-discovery.mjs` resolves the root in order
(`CODEX_HOME` → Orca runtime home → `~/.codex`), and for every file reports its thread, mtime,
size, **SHA-256** and **pixel dimensions read from the PNG IHDR chunk**. It exits **2** when it
cannot read a store at all, because *"I could not look"* must never render as *"nothing was
generated"*.

Unreadable dimensions come back as `null`, not `0`. A corrupt artifact still appears in the
listing — "there is a file and we cannot measure it" is precisely the state a caller must see.

## A requested size is not an output size

Asking for `512x512` returned `1254x1254`. Across the nine images in the observed store the
dimensions are **1254×1254, 1295×1214 and 1536×1024** — so even the 1254 figure is one common
outcome rather than a contract.

Requested dimensions are **advisory**. Where an exact size matters, post-process deterministically
and declare the policy per asset (crop / contain / cover / padding / resampling). Do not stretch a
layout to hit a number.

Final geometry for anything implementable is settled by the **renderer**, not by a generated
image's pixel count. A generated PNG is design lineage; a token-true render is implementation
evidence.

## Quota is a bounded resource

Generation spends the ChatGPT plan's image quota, not a card.
`UsageLimitExceededImageGenerationFailure` with a real `limitId` means *the capability is present
and the allowance is spent* — it is not an authentication or billing misconfiguration.

So the loop optimises **information gain per generation**, not image count:

- one strong candidate → critique → deterministic correction, over ten near-identical draws;
- stop generating when the remaining problems are token, spacing, radius, copy or layout
  problems, because those are cheaper and more exactly solved in the renderer;
- Codex can *see* an image via `-i` and critique it, so a critique costs no image quota.

## Checklist for a generation turn

1. Record the timestamp before generating.
2. Generate.
3. `pnpm discover:generated-images -- --since <that timestamp>` — **ignore the prose**.
4. Confirm the artifact exists, its dimensions are readable, and its hash is new.
5. Critique against the constitution; name a concrete delta, never "make it better".
6. Regenerate only while information gain remains; otherwise fix it in the renderer.
7. Ingest the chosen candidate into `docs/visual/generated/` with its provenance (source path,
   hash, thread, requested vs actual size) and register it.

A generated image that never leaves the Codex home is not a deliverable. It is also not deleted
from there by this pipeline — that store belongs to Codex.
