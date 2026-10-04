import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'

// The driver runs sudo mount/losetup, so these rows never reach the real ones: PATH holds shims that log
// their argv, and the `sudo` shim never executes its argument. A small stateful fake (loop attached,
// mounted) answers the probes the way the real tools would, so release and recovery are driven end to end.
export const linux = describe.skipIf(process.platform !== 'linux')

const HERE = import.meta.dirname
const REPO = join(HERE, '..', '..')
export const SCRIPT = join(HERE, 'real-enospc-volume.sh')
const SBIN_LINE = "REAL_ENOSPC_SBIN_DIRS='/usr/sbin /sbin'"
export const FAKE_DEV = '/dev/loop77'

const SHIMS = {
  sudo: `#!/bin/bash
echo "sudo $*" >> "$SHIM_DIR/calls.log"
[ "\${1:-}" = -n ] && shift
tool=$(basename -- "\${1:-}")
shift
flag=\${1:-}
flag=\${flag#-}
resp=$SHIM_DIR/resp
st=$SHIM_DIR/state
rc_of() { cat "$resp/$1.rc" 2> /dev/null || echo 0; }
case "$tool" in
  true) exit "$(rc_of true)" ;;
  losetup)
    case "$flag" in
      f)
        [ "$(rc_of losetup_f)" = 0 ] || exit "$(rc_of losetup_f)"
        mkdir -p "$st"
        : > "$st/loop"
        if [ -e "$resp/losetup_f.out" ]; then cat "$resp/losetup_f.out"; else echo ${FAKE_DEV}; fi
        ;;
      j)
        [ "$(rc_of losetup_j)" = 0 ] || exit "$(rc_of losetup_j)"
        if [ -e "$resp/losetup_j.out" ]; then
          cat "$resp/losetup_j.out"
        elif [ -e "$st/loop" ]; then
          echo "${FAKE_DEV}: [1]:1 ($2)"
        fi
        ;;
      d)
        [ "$(rc_of losetup_d)" = 0 ] || exit "$(rc_of losetup_d)"
        rm -f "$st/loop"
        ;;
    esac
    ;;
  mount)
    [ "$(rc_of mount)" = 0 ] || exit "$(rc_of mount)"
    mkdir -p "$st"
    : > "$st/mounted"
    ;;
  umount)
    [ "$(rc_of umount)" = 0 ] || exit "$(rc_of umount)"
    rm -f "$st/mounted"
    ;;
esac
exit 0
`,
  uname: `#!/bin/bash
cat "$SHIM_DIR/resp/uname.out" 2> /dev/null || echo Linux
`,
  mountpoint: `#!/bin/bash
echo "mountpoint $*" >> "$SHIM_DIR/calls.log"
[ -e "$SHIM_DIR/resp/blind" ] && exit 1
[ -e "$SHIM_DIR/state/mounted" ]
`,
  findmnt: `#!/bin/bash
echo "findmnt $*" >> "$SHIM_DIR/calls.log"
[ -e "$SHIM_DIR/resp/blind" ] && exit 1
[ -e "$SHIM_DIR/state/mounted" ] || exit 1
echo ${FAKE_DEV}
`,
  stat: `#!/bin/bash
case " $* " in
  *" -f "*)
    case " $* " in
      *"%b"*) echo 8192 ;;
      *"%S"*) echo 1024 ;;
    esac
    ;;
  *"%u"*)
    case "\${@: -1}" in
      *.real-enospc-volume.marker) over=$SHIM_DIR/resp/stat_uid_marker ;;
      */p3-enospc-*) over=$SHIM_DIR/resp/stat_uid_dir ;;
      *) over=$SHIM_DIR/resp/stat_uid_parent ;;
    esac
    if [ -e "$over" ]; then cat "$over"; else exec /usr/bin/stat "$@"; fi
    ;;
  *) exec /usr/bin/stat "$@" ;;
esac
`,
  'mkfs.ext4': `#!/bin/bash
echo "mkfs.ext4 $*" >> "$SHIM_DIR/calls.log"
`,
  losetup: `#!/bin/bash
echo "LOSETUP-DIRECT $*" >> "$SHIM_DIR/calls.log"
`
}

const base = (() => {
  mkdirSync(join(REPO, 'tmp'), { recursive: true })
  return mkdtempSync(join(REPO, 'tmp', 'real-enospc-volume-test-'))
})()
let rowN = 0

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

export function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A fresh row: shim dir, scripted responses, and a run-dir parent the driver may create into. */
export function makeRow() {
  rowN += 1
  const root = join(base, `row-${rowN}`)
  const shim = join(root, 'shim')
  const emptyDir = join(root, 'empty-sbin')
  mkdirSync(join(shim, 'resp'), { recursive: true })
  // Why: the driver refuses a group/other-writable parent, and a 0002 host umask would make every row's parent one.
  chmodSync(root, 0o755)
  mkdirSync(join(shim, 'state'), { recursive: true })
  mkdirSync(emptyDir)
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(join(shim, name), body)
    chmodSync(join(shim, name), 0o755)
  }
  writeFileSync(join(shim, 'calls.log'), '')
  return {
    root,
    shim,
    emptyDir,
    runDir: join(root, 'p3-enospc-vol-row'),
    resp: (name, body) => writeFileSync(join(shim, 'resp', name), body),
    setState: (name) => writeFileSync(join(shim, 'state', name), ''),
    calls: () => readFileSync(join(shim, 'calls.log'), 'utf8'),
    sudoCalls: () =>
      readFileSync(join(shim, 'calls.log'), 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('sudo ') || line.startsWith('LOSETUP-DIRECT'))
  }
}

/** tools: 'real' runs the committed script; 'shim' / 'empty' run a copy whose pinned tool list is replaced. */
export function drive(row, args, { tools = 'real' } = {}) {
  let script = SCRIPT
  if (tools !== 'real') {
    const source = readFileSync(SCRIPT, 'utf8')
    const occurrences = source.split(SBIN_LINE).length - 1
    // Positive control: the copy is not the unmodified script, and the replaced line exists exactly once.
    expect(occurrences, 'the pinned tool line must occur exactly once').toBe(1)
    const dir = tools === 'shim' ? row.shim : row.emptyDir
    script = join(row.root, 'driver-copy.sh')
    writeFileSync(script, source.replace(SBIN_LINE, `REAL_ENOSPC_SBIN_DIRS='${dir}'`))
    expect(readFileSync(script, 'utf8')).not.toBe(source)
  }
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${row.shim}:${process.env.PATH}`, SHIM_DIR: row.shim }
  })
  return { ...result, out: `${result.stdout}${result.stderr}` }
}

export const runArgs = (row, extra = []) => ['--run-dir', row.runDir, ...extra, '--', '/bin/true']
