# orca.yaml `requirements:`

Status: experimental. The shape may change before a release; nothing is published by this phase.

A project can declare what a host needs in order to run it, in the same `orca.yaml` that already
holds `scripts:` and `defaultTabs:`. Orca measures each requirement on the host that will run the
project (this device, an SSH host through its relay, or a runtime host) and reports what it found.
Measuring is read-only: nothing in this document runs a command that the project supplied.

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
| `prepare` | PLANNED | the project-declared command text, run only after approval (slice 20-02) | nothing in this slice |
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
  bytes are what an approval will cover.

## Limits

The file is bounded to 256 KiB, a field to 64 KiB, and the list to 256 entries. At most 64
requirements are measured in one request.

Residual risk: a user-writable PATH directory outside the workspace is not detected, so a command
found there is still measured by running it once.
