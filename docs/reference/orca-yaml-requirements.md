# orca.yaml `requirements:`

Status: experimental. The shape may change before a release; nothing is published by this phase.

A project can declare what a host needs in order to run it, in the same `orca.yaml` that already
holds `scripts:` and `defaultTabs:`. Orca measures each requirement on the host that will run the
project (this device, an SSH host through its relay, or a runtime host) and reports what it found.
Measuring is read-only. The only command from the project that can ever run is a `prepare` the
person approved (see Prepare below).

## Example

```yaml
requirements:
  - id: git
    kind: command
    name: git
    version: ">=2.25"
    description: Source control
  - id: node
    kind: command
    name: node
    version: ">=20 <23"
    versionArgs: --version
    platforms:
      - os: linux
      - os: darwin
  - id: claude
    kind: agent
    provider: claude
  - id: posix
    kind: platform
    os: linux
    arch: x64
  - id: api-token
    kind: env
    name: ORCA_API_TOKEN
  - id: github
    kind: credential
    provider: gh
  - id: gpu0
    kind: gpu
```

The last row uses a kind this Orca does not know. It is kept and shown as unknown rather than
dropped.

## Kinds

| kind | status | measured how | what crosses the wire |
| --- | --- | --- | --- |
| `command` | LIVE | the name is resolved on the host without searching the current directory, then run once with a version argument | the resolved path and the extracted version |
| `agent` | LIVE | the provider's detection commands from the agent catalog are resolved on the host | whether the agent was found |
| `platform` | LIVE | the host reports its operating system and architecture | the operating system and architecture names |
| `env` | LIVE | the variable name is looked up in the environment the project's shell would see | presence only, never the value |
| `credential` | LIVE | `gh` or `glab` is resolved, then its sign-in state is read on the host | a signed-in flag only, never a token or command output |
| `prepare` | LIVE | the project-declared command text, run in a visible terminal only after the person approves those exact bytes for that host (see Prepare below) | a hash of the approved bytes; never the output of the command |
| `gpu` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `service` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `database` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `container` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `mcp` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `browser` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `skills` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |
| `hooks` | ABSENT | not evaluated by this Orca version; classified unknown | nothing |

LIVE means implemented and exercised by a test. PLANNED means not implemented; the slice that builds
it is named. ABSENT means described here but not implemented.

## Rules

- A command is a name, never a path. Letters, digits, `.`, `_`, `+` and `-` only, up to 64
  characters, starting with a letter or digit.
- `versionArgs` is one of `--version`, `-v`, `-V` or `version`. Version ranges are space-separated
  `>=`, `>`, `<=`, `<` and `=` comparators over `MAJOR[.MINOR[.PATCH]]`. Anything else is reported
  as a diagnostic and the row is shown as unknown, never as satisfied.
- An `env` requirement names a variable. There is no field that can hold its value, and a `value` or
  `default` field is rejected.
- A `credential` requirement reads sign-in state only, for `gh` or `glab`.
- A `platforms:` list limits a row to the listed operating systems and architectures. A host outside
  the list is not probed.
- An unknown kind is kept and shown as unknown ("not evaluated by this Orca version").
- A row Orca cannot read is kept as malformed beside a diagnostic. It is never omitted.
- A file Orca cannot read or parse is unreadable, which is different from a file with no
  requirements. The first is reported as unknown; only the second means "nothing required".
- Probes run on the host that runs the project. A resolution that lands inside the project's own
  workspace is refused, and a Windows `.cmd` or `.bat` shim is never executed (it is reported by
  presence only).
- `prepare` text is taken verbatim, with no trimming or newline normalization, because those exact
  bytes are what an approval covers.

## Prepare

Only approved prepare commands run. Orca never adds a step of its own: a step exists only for a row
whose `prepare` the project declared, and it never elevates (a first word of `sudo`, `doas`, `pkexec`
or `runas` is labelled "asks for elevation"; a relative script path is labelled "script content not
covered", because the approval names the command line and not the file it calls).

A step is spawned in a visible terminal, by the host that will run it, only when all four hold at
the moment of the run:

1. The host re-reads `orca.yaml` and finds the requirement with a `prepare`
   (`contract-unreadable`, `requirement-not-declared` otherwise).
2. The approval hash matches. It is `sha256` of `prepare:<requirement id>`, a line feed, the host key
   and a line feed, then the verbatim command text. The host recomputes it with its own host key
   from the bytes it just re-read: a hash for other text is `contract-changed`, a hash made for
   another host is `approval-for-another-host`.
3. A desktop approval is on record: the stored entry must exist and equal the recomputed hash
   (`approval-missing` when absent or malformed, `approval-unreadable` when the store cannot be
   read; neither is ever read as a match). Repo-wide "trust all" never authorizes a prepare step.
4. The host is trusted and the requirement is still unmet: an SSH host must have a pinned or
   delegated identity (`host-identity-unverified`), a satisfied requirement is `already-satisfied`
   and one that does not apply to the host is `requirement-not-applicable`.

What runs is the re-read text, never text supplied by the caller: the request carries only a
requirement id and a hash. The order is read the file, re-measure that one requirement, read the
file again (a different content hash is `contract-changed`), read the host identity and the stored
approval, authorize, spawn.

On a runtime host (`orca serve`) the host runs only the bytes whose hash the caller presented and that
it re-read itself; the grant itself is the caller's, not recorded host-side.

An approval write is an in-memory update with a debounced save (`store.ts` `updateUI`), so it is not
crash-durable, and two windows writing the approval map at once are last-writer-wins.

Window: between the final re-read and the terminal's process starting, the file on disk may change
(it does not change what runs, because the re-read text is what is spawned), an approval may be
revoked or an SSH host re-keyed (neither is observed), and the requirement may be met by someone
else (harmless). The terminal's exit code is never read; the person measures again to see the result.

## Limits

The file is bounded to 256 KiB, a field to 64 KiB, and the list to 256 entries. At most 64
requirements are measured in one request.

Residual risk: a user-writable PATH directory outside the workspace is not detected, so a command
found there is still measured by running it once.
