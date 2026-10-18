# Rows 52 and 53 - DWS lessons as PP vault records and UKDL entries (2026-10-18)

Where: claude-power-pack worktree `C:\Users\User\Apps\pp-dws-rows-wt`, branch `dws/pp-rows`, commit `a1f5f45b` (local, not pushed; push is Owner-gated).

## Row 52 - records in vault/lessons (format of the existing files: front matter, Evidence, Lesson)

- `dws-ink-screen-reads-spaces-as-csi-c.md` - from the row 70 r70r3 run.
- `dws-service-home-restore-leaves-no-claude-projects.md` - r70r4 and the row 59 passing run (`HWF_CLAUDE_PROJECTS=0`, `SVC_HOME_RESTORED=True`).
- `dws-bypass-permissions-consent-belongs-to-the-owner.md` - r70r4 and `HWF59M_ARGV_BYPASS_FLAG=absent`.
- `dws-session-transfer-is-proved-by-the-target-read-back.md` - r70r5 and mutant r70m.

Each cites the Orca evidence file under `docs/dws/` and a commit.

## Row 53 - UKDL

Four entries appended to `vault/knowledge_base/ukdl-universal.md` under `DWS program traps (2026-10-18)`, in that file's own shape (id, Fix, Evidence): `T-INK-SCREEN-SPACE-IS-CSI-C-001`, `T-LIVE-LEG-MUST-RESTORE-THE-SERVICE-HOME-001`, `T-A-TEST-DOES-NOT-ACCEPT-BYPASS-PERMISSIONS-001`, `T-SESSION-TRANSFER-NEEDS-AN-INDEPENDENT-READ-BACK-001`. Searched first for `CSI`, `cursor-forward`, `Bypass Permissions`, `service home` and the four ids: no existing entry covers any of them (the only `bypass` hits are unrelated).

## Validation

`python tools/vault_sync.py --vault vault/lessons --validate` reports no error against the four new files (they carry `title` and `tier`). It still reports errors for 63 other files in `vault/lessons`, which were failing it before this change; that validator targets the `~/.claude/knowledge_vault` front-matter regime, not these lessons.

## Not covered

The four ids are not registered as hard rules and are not in the compiled hard-rule set; they are trap records.
