import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// The driver runs sudo mount/losetup, so these rows never reach the real ones: PATH holds shims that log
// their argv, and the `sudo` shim never executes its argument. A small stateful fake (loop attached,
// mounted) answers the probes the way the real tools would, so release and recovery are driven end to end.
const linux = describe.skipIf(process.platform !== 'linux')

const HERE = import.meta.dirname
const REPO = join(HERE, '..', '..')
const SCRIPT = join(HERE, 'real-enospc-volume.sh')
const SBIN_LINE = "REAL_ENOSPC_SBIN_DIRS='/usr/sbin /sbin'"
const FAKE_DEV = '/dev/loop77'

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

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A fresh row: shim dir, scripted responses, and a run-dir parent the driver may create into. */
function makeRow() {
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
function drive(row, args, { tools = 'real' } = {}) {
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

const runArgs = (row, extra = []) => ['--run-dir', row.runDir, ...extra, '--', '/bin/true']

linux('real-enospc-volume.sh refusals (no sudo mount ever runs)', () => {
  it('has no host path, mass unmount, detach-all or recursive removal in its code', () => {
    const code = readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toContain('/home/')
    expect(code).not.toMatch(/umount\s+(-\w*a|--all)/)
    expect(code).not.toMatch(/losetup["\s$A-Z]*\s-D\b/)
    expect(code).not.toMatch(/\brm\s+-\w*r/)
    expect(code).not.toMatch(/umount\s+-\w*l/)
  })

  it('a missing --run-dir is a usage error', () => {
    const row = makeRow()
    const run = drive(row, ['--', '/bin/true'])
    expect(run.status).toBe(2)
    expect(run.out).toContain('USAGE')
    expect(row.sudoCalls()).toEqual([])
  })

  it('refuses a run dir under /tmp before any sudo call', () => {
    const row = makeRow()
    const run = drive(row, ['--run-dir', '/tmp/p3-enospc-x', '--', '/bin/true'])
    expect(run.status).toBe(2)
    expect(run.out).toContain('REFUSED run-dir-tmp')
    expect(row.sudoCalls()).toEqual([])
    expect(existsSync('/tmp/p3-enospc-x')).toBe(false)
  })

  it('refuses a run dir whose basename lacks the p3-enospc- prefix before any sudo call', () => {
    const row = makeRow()
    const run = drive(row, ['--run-dir', join(row.root, 'volume-row'), '--', '/bin/true'])
    expect(run.status).toBe(2)
    expect(run.out).toContain('REFUSED run-dir-prefix')
    expect(row.sudoCalls()).toEqual([])
    expect(existsSync(join(row.root, 'volume-row'))).toBe(false)
  })

  it('refuses an existing run dir and leaves what is inside it byte-identical', () => {
    const row = makeRow()
    mkdirSync(row.runDir)
    const sentinel = join(row.runDir, 'sentinel.txt')
    writeFileSync(sentinel, 'do not touch\n')
    const before = sha(sentinel)
    const run = drive(row, runArgs(row))
    expect(run.status).toBe(2)
    expect(run.out).toContain('REFUSED run-dir-exists')
    expect(sha(sentinel)).toBe(before)
    expect(existsSync(join(row.runDir, '.real-enospc-volume.marker'))).toBe(false)
    expect(row.sudoCalls()).toEqual([])
  })

  it('refuses a run dir whose parent does not exist', () => {
    const row = makeRow()
    const run = drive(row, [
      '--run-dir',
      join(row.root, 'missing', 'p3-enospc-vol-x'),
      '--',
      '/bin/true'
    ])
    expect(run.status).toBe(2)
    expect(run.out).toContain('REFUSED run-dir-parent')
    expect(row.sudoCalls()).toEqual([])
  })

  it('refuses a run dir that only reaches /tmp through an ancestor symlink, before any sudo call', () => {
    const row = makeRow()
    const real = mkdtempSync('/tmp/p3-enospc-ancestor-')
    try {
      mkdirSync(join(real, 'sub'))
      symlinkSync(real, join(row.root, 'alias'))
      const run = drive(
        row,
        ['--run-dir', join(row.root, 'alias', 'sub', 'p3-enospc-x'), '--', '/bin/true'],
        {
          tools: 'shim'
        }
      )
      expect(run.status, run.out).toBe(2)
      expect(run.out).toContain('REFUSED run-dir-tmp')
      expect(row.sudoCalls()).toEqual([])
      expect(existsSync(join(real, 'sub', 'p3-enospc-x'))).toBe(false)
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('refuses a run dir whose parent is group-writable, before any sudo call and before creating anything', () => {
    const row = makeRow()
    chmodSync(row.root, 0o775)
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain('REFUSED run-dir-parent')
    expect(row.sudoCalls()).toEqual([])
    expect(existsSync(row.runDir)).toBe(false)
  })

  it('refuses a size over the cap before any sudo call', () => {
    const row = makeRow()
    const run = drive(row, runArgs(row, ['--size-mb', '65']))
    expect(run.status).toBe(2)
    expect(run.out).toContain('REFUSED size-mb 65')
    expect(row.sudoCalls()).toEqual([])
    expect(existsSync(row.runDir)).toBe(false)
  })

  it('refuses a tmpfs fallback larger than 4 MB', () => {
    const row = makeRow()
    const run = drive(row, runArgs(row, ['--fs', 'tmpfs', '--size-mb', '8']))
    expect(run.status).toBe(2)
    expect(run.out).toContain('tmpfs fallback is at most 4 MB')
    expect(row.sudoCalls()).toEqual([])
  })

  it('reports a non-Linux host as a missing precondition and creates nothing', () => {
    const row = makeRow()
    row.resp('uname.out', 'Darwin\n')
    const run = drive(row, runArgs(row))
    expect(run.status).toBe(3)
    expect(run.out).toContain('PRECONDITION_MISSING linux')
    expect(existsSync(row.runDir)).toBe(false)
    expect(row.sudoCalls()).toEqual([])
  })

  it('without non-interactive sudo it is BLOCKED_EXTERNAL and no losetup or mount call is made', () => {
    const row = makeRow()
    row.resp('true.rc', '1')
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status).toBe(3)
    expect(run.out).toContain('BLOCKED_EXTERNAL needs a bounded filesystem')
    expect(row.sudoCalls()).toEqual(['sudo -n true'])
    expect(existsSync(row.runDir)).toBe(false)
  })

  it('a pinned tool list with no losetup is a missing precondition before any sudo losetup or mount', () => {
    const row = makeRow()
    const run = drive(row, runArgs(row), { tools: 'empty' })
    expect(run.status).toBe(3)
    expect(run.out).toContain('PRECONDITION_MISSING losetup')
    expect(row.sudoCalls()).toEqual(['sudo -n true'])
    expect(existsSync(row.runDir)).toBe(false)
  })

  it('an already-mounted mountpoint is refused with nothing mounted or unmounted', () => {
    const row = makeRow()
    row.setState('mounted')
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status).toBe(4)
    expect(run.out).toContain('ALREADY_MOUNTED')
    const calls = row.sudoCalls()
    expect(calls).toEqual(['sudo -n true'])
    expect(existsSync(join(row.runDir, 'mnt'))).toBe(true)
    expect(existsSync(join(row.runDir, 'volume.img'))).toBe(false)
  })
})

linux('real-enospc-volume.sh run and release (stateful fake)', () => {
  it('records the device before mounting, runs the command on the volume and releases only that device', () => {
    const row = makeRow()
    const run = drive(
      row,
      ['--run-dir', row.runDir, '--', '/bin/sh', '-c', 'echo VOL=$ORCA_ENOSPC_VOLUME'],
      { tools: 'shim' }
    )
    expect(run.status, run.out).toBe(0)
    expect(run.out).toContain(`VOL=${join(row.runDir, 'mnt')}`)
    const log = readFileSync(join(row.runDir, 'volume.log'), 'utf8')
    expect(log.indexOf(`LOOP_DEVICE ${FAKE_DEV}`)).toBeGreaterThan(-1)
    expect(log.indexOf('LOOP_DEVICE')).toBeLessThan(log.indexOf('VOLUME fs=ext4'))
    expect(log).toMatch(/^COMMAND_EXIT 0 seconds=\d+$/m)
    expect(log).toContain('LEFTOVER_PROBE_PRE mount=1 loop=1')
    expect(log).toMatch(/^LEFTOVER mount=0 loop=0 device=\/dev\/loop77$/m)
    expect(readFileSync(join(row.runDir, 'loop-device.txt'), 'utf8').trim()).toBe(FAKE_DEV)
    expect(existsSync(join(row.runDir, 'volume.img'))).toBe(false)
    expect(existsSync(join(row.runDir, 'mnt'))).toBe(false)
    expect(existsSync(join(row.runDir, '.real-enospc-volume.marker'))).toBe(true)
    const shimDir = row.shim
    expect(row.sudoCalls()).toEqual([
      'sudo -n true',
      `sudo -n ${shimDir}/losetup -f --show ${row.runDir}/volume.img`,
      `sudo -n mount -t ext4 ${FAKE_DEV} ${row.runDir}/mnt`,
      `sudo -n chown ${process.getuid()}:${process.getgid()} -- ${row.runDir}/mnt`,
      `sudo -n ${shimDir}/losetup -j ${row.runDir}/volume.img`,
      `sudo -n umount -- ${row.runDir}/mnt`,
      `sudo -n ${shimDir}/losetup -j ${row.runDir}/volume.img`,
      `sudo -n ${shimDir}/losetup -d ${FAKE_DEV}`,
      `sudo -n ${shimDir}/losetup -j ${row.runDir}/volume.img`
    ])
    expect(row.calls()).not.toContain('LOSETUP-DIRECT')
  })

  it('a failing command exits 1 and the volume is still released', () => {
    const row = makeRow()
    const run = drive(row, ['--run-dir', row.runDir, '--', '/bin/sh', '-c', 'exit 7'], {
      tools: 'shim'
    })
    expect(run.status).toBe(1)
    expect(run.out).toContain('COMMAND_EXIT 7')
    expect(run.out).toContain('LEFTOVER mount=0 loop=0')
    expect(existsSync(join(row.runDir, 'volume.img'))).toBe(false)
  })

  it('SIGTERM during the command still runs the release trap', () => {
    const row = makeRow()
    const run = drive(
      row,
      ['--run-dir', row.runDir, '--', '/bin/sh', '-c', 'kill -TERM $PPID; sleep 1'],
      { tools: 'shim' }
    )
    expect(run.status).toBe(143)
    expect(run.out).toContain('LEFTOVER mount=0 loop=0')
    expect(row.sudoCalls().some((line) => line.endsWith(`-d ${FAKE_DEV}`))).toBe(true)
  })

  it('a busy unmount is reported, never forced, and the loop device is not detached under it', () => {
    const row = makeRow()
    row.resp('umount.rc', '1')
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status).toBe(5)
    expect(run.out).toContain('UMOUNT_FAILED')
    expect(run.out).toContain('DETACH_SKIPPED still-mounted')
    expect(run.out).toMatch(/LEFTOVER mount=1 loop=1/)
    const calls = row.sudoCalls()
    expect(calls.some((line) => / -d /.test(line))).toBe(false)
    expect(calls.some((line) => /umount (-\w*[al]|--lazy|--all)/.test(line))).toBe(false)
    expect(existsSync(join(row.runDir, 'volume.img'))).toBe(true)
  })

  it('a blind leftover instrument is exit 6, not a clean green', () => {
    const row = makeRow()
    row.resp('blind', '')
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status).toBe(6)
    expect(run.out).toContain('LEFTOVER_PROBE_PRE mount=0')
    expect(run.out).toContain('LEFTOVER_INSTRUMENT_BLIND')
  })

  it('a loop probe that fails is read as a leftover, not as absent', () => {
    const row = makeRow()
    row.resp('losetup_j.rc', '1')
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status).toBe(5)
    expect(run.out).toContain('LOOP_PROBE_FAILED')
    expect(run.out).toMatch(/LEFTOVER mount=0 loop=1/)
  })

  it('an unparseable losetup answer recovers only the device its own probe names', () => {
    const row = makeRow()
    row.resp('losetup_f.out', 'not a device\n')
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status).toBe(3)
    expect(run.out).toContain(`DEVICE_UNRECORDED recovered=${FAKE_DEV}`)
    expect(row.sudoCalls().filter((line) => / -d /.test(line))).toEqual([
      `sudo -n ${row.shim}/losetup -d ${FAKE_DEV}`
    ])
    expect(row.calls()).not.toMatch(/sudo -n mount/)
  })
})

linux('real-enospc-volume.sh --recover', () => {
  const MARKER = 'real-enospc-volume marker v1 pid=1234 nonce=00ff00ff00ff00ff\n'

  function killedRun(row, { mounted = false } = {}) {
    mkdirSync(join(row.runDir, 'mnt'), { recursive: true })
    chmodSync(row.runDir, 0o700)
    writeFileSync(join(row.runDir, '.real-enospc-volume.marker'), MARKER)
    writeFileSync(join(row.runDir, 'loop-device.txt'), `${FAKE_DEV}\n`)
    writeFileSync(join(row.runDir, 'volume.img'), 'image')
    row.setState('loop')
    if (mounted) {
      row.setState('mounted')
    }
  }

  it('refuses a directory without the driver marker and calls nothing', () => {
    const row = makeRow()
    mkdirSync(row.runDir)
    writeFileSync(join(row.runDir, 'loop-device.txt'), `${FAKE_DEV}\n`)
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status).toBe(2)
    expect(run.out).toContain('RECOVER_REFUSED no-marker')
    expect(row.sudoCalls()).toEqual([])
  })

  it('refuses when losetup -j names another device than the one recorded, and never detaches', () => {
    const row = makeRow()
    killedRun(row)
    row.resp('losetup_j.out', '/dev/loop99: [1]:1 (/elsewhere.img)\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status).toBe(5)
    expect(run.out).toContain('RECOVER_REFUSED owner-mismatch')
    expect(row.sudoCalls().filter((line) => / -d /.test(line))).toEqual([])
    expect(run.out).toMatch(/LEFTOVER mount=0 loop=1/)
    expect(existsSync(join(row.runDir, 'volume.img'))).toBe(true)
  })

  it('detaches exactly the recorded device once losetup -j names it, without ever mounting or attaching', () => {
    const row = makeRow()
    killedRun(row)
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(0)
    expect(row.sudoCalls().filter((line) => / -d /.test(line))).toEqual([
      `sudo -n ${row.shim}/losetup -d ${FAKE_DEV}`
    ])
    expect(row.calls()).not.toMatch(/ -f /)
    expect(row.calls()).not.toMatch(/sudo -n mount/)
    expect(run.out).toContain('RECOVER dev=/dev/loop77 mount_before=0 loop_before=1')
    expect(run.out).toContain('LEFTOVER mount=0 loop=0')
    expect(existsSync(join(row.runDir, 'volume.img'))).toBe(false)
    expect(existsSync(join(row.runDir, 'mnt'))).toBe(false)
  })

  it('recovers a run dir the driver itself made under a setgid parent (mode 2700)', () => {
    const row = makeRow()
    chmodSync(row.root, 0o2755)
    // Killed with SIGKILL mid-command: no trap runs, so the loop device and mount stay as a crash leaves them.
    const run = drive(row, ['--run-dir', row.runDir, '--', '/bin/sh', '-c', 'kill -KILL $PPID'], {
      tools: 'shim'
    })
    expect(run.status, run.out).not.toBe(0)
    // Positive control: the driver's own mkdir really inherited the setgid bit, so the row exercises the case.
    expect(statSync(row.runDir).mode & 0o7777).toBe(0o2700)
    expect(row.sudoCalls().some((line) => line.includes('mount -t ext4'))).toBe(true)
    const recovered = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(recovered.status, recovered.out).toBe(0)
    expect(row.sudoCalls().filter((line) => / -d /.test(line))).toEqual([
      `sudo -n ${row.shim}/losetup -d ${FAKE_DEV}`
    ])
    expect(recovered.out).toContain('LEFTOVER mount=0 loop=0')
  })

  it('recovers a physical run dir whose parent is reached through an ancestor symlink', () => {
    const row = makeRow()
    killedRun(row, { mounted: true })
    symlinkSync(row.root, join(row.root, '..', `alias-${row.root.split('/').pop()}`))
    const viaAlias = join(row.root, '..', `alias-${row.root.split('/').pop()}`, 'p3-enospc-vol-row')
    const run = drive(row, ['--recover', '--run-dir', viaAlias], { tools: 'shim' })
    expect(run.status, run.out).toBe(0)
    expect(run.out).toContain(`UMOUNT ok mnt=${row.runDir}/mnt`)
  })

  it('unmounts the run dir mount of the recorded device before detaching it', () => {
    const row = makeRow()
    killedRun(row, { mounted: true })
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(0)
    const sudo = row.sudoCalls().filter((line) => /umount| -d /.test(line))
    expect(sudo).toEqual([
      `sudo -n umount -- ${row.runDir}/mnt`,
      `sudo -n ${row.shim}/losetup -d ${FAKE_DEV}`
    ])
  })

  // Every row below plants a recoverable-looking run dir that the driver did not make; none may reach umount or -d.
  function expectRefusedUntouched(row, run, reason) {
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain(`RECOVER_REFUSED ${reason}`)
    expect(row.sudoCalls().filter((line) => /umount| -d /.test(line))).toEqual([])
    expect(existsSync(join(row.root, 'foreign-target'))).toBe(true)
  }

  function foreignTarget(row) {
    const target = join(row.root, 'foreign-target')
    mkdirSync(target, { recursive: true })
    return target
  }

  it('refuses a symlinked mnt that points at a foreign mount, and never unmounts or detaches', () => {
    const row = makeRow()
    const target = foreignTarget(row)
    killedRun(row, { mounted: true })
    rmSync(join(row.runDir, 'mnt'), { recursive: true })
    symlinkSync(target, join(row.runDir, 'mnt'))
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'symlink')
  })

  it('refuses a symlinked volume.img that points at a foreign backing file', () => {
    const row = makeRow()
    const target = foreignTarget(row)
    writeFileSync(join(target, 'disk.img'), 'foreign')
    killedRun(row)
    rmSync(join(row.runDir, 'volume.img'))
    symlinkSync(join(target, 'disk.img'), join(row.runDir, 'volume.img'))
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'symlink')
    expect(readFileSync(join(target, 'disk.img'), 'utf8')).toBe('foreign')
  })

  it('refuses a symlinked loop-device.txt and a symlinked marker', () => {
    const linkedRecord = makeRow()
    const target = foreignTarget(linkedRecord)
    writeFileSync(join(target, 'record'), `${FAKE_DEV}\n`)
    killedRun(linkedRecord)
    rmSync(join(linkedRecord.runDir, 'loop-device.txt'))
    symlinkSync(join(target, 'record'), join(linkedRecord.runDir, 'loop-device.txt'))
    expectRefusedUntouched(
      linkedRecord,
      drive(linkedRecord, ['--recover', '--run-dir', linkedRecord.runDir], { tools: 'shim' }),
      'symlink'
    )

    const linkedMarker = makeRow()
    const markerTarget = foreignTarget(linkedMarker)
    writeFileSync(join(markerTarget, 'marker'), MARKER)
    killedRun(linkedMarker)
    rmSync(join(linkedMarker.runDir, '.real-enospc-volume.marker'))
    symlinkSync(
      join(markerTarget, 'marker'),
      join(linkedMarker.runDir, '.real-enospc-volume.marker')
    )
    const run = drive(linkedMarker, ['--recover', '--run-dir', linkedMarker.runDir], {
      tools: 'shim'
    })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain('RECOVER_REFUSED no-marker')
    expect(linkedMarker.sudoCalls()).toEqual([])
  })

  it('refuses a run dir that is itself a symlink to a real run dir', () => {
    const row = makeRow()
    foreignTarget(row)
    killedRun(row)
    const alias = join(row.root, 'p3-enospc-alias')
    symlinkSync(row.runDir, alias)
    const run = drive(row, ['--recover', '--run-dir', alias], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'no-marker')
  })

  it('refuses a run dir owned by someone else', () => {
    const row = makeRow()
    foreignTarget(row)
    killedRun(row, { mounted: true })
    row.resp('stat_uid_dir', '0\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'not-owned')
  })

  it('refuses a marker owned by someone else inside a run dir the caller owns', () => {
    const row = makeRow()
    foreignTarget(row)
    killedRun(row, { mounted: true })
    row.resp('stat_uid_marker', '0\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'not-owned')
    expect(run.out).toContain('.real-enospc-volume.marker')
  })

  it('refuses a run dir the driver would not have created (not 0700)', () => {
    const row = makeRow()
    foreignTarget(row)
    killedRun(row, { mounted: true })
    chmodSync(row.runDir, 0o777)
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'not-owned')
  })

  function plantLogLink(row) {
    const victim = join(row.root, 'victim.txt')
    writeFileSync(victim, 'victim bytes\n')
    symlinkSync(victim, join(row.runDir, 'volume.log'))
    return { victim, before: sha(victim) }
  }

  it("a refusal of a run dir that is not the caller's never writes through its volume.log symlink", () => {
    const row = makeRow()
    killedRun(row, { mounted: true })
    chmodSync(row.runDir, 0o755)
    const { victim, before } = plantLogLink(row)
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain('RECOVER_REFUSED not-owned')
    expect(sha(victim)).toBe(before)
    expect(row.sudoCalls()).toEqual([])
  })

  it('refuses, and does not append to, a volume.log symlink inside a run dir the caller owns', () => {
    const row = makeRow()
    killedRun(row, { mounted: true })
    const { victim, before } = plantLogLink(row)
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain(`RECOVER_REFUSED symlink ${row.runDir}/volume.log`)
    expect(sha(victim)).toBe(before)
    expect(row.sudoCalls()).toEqual([])
  })

  it('refuses an existing run dir without writing through its volume.log symlink', () => {
    const row = makeRow()
    mkdirSync(row.runDir)
    const { victim, before } = plantLogLink(row)
    const run = drive(row, runArgs(row), { tools: 'shim' })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain('REFUSED run-dir-exists')
    expect(sha(victim)).toBe(before)
  })

  it('still appends to a regular volume.log of an own run dir (control: the log is not simply off)', () => {
    const row = makeRow()
    killedRun(row)
    writeFileSync(join(row.runDir, 'volume.log'), 'earlier line\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(0)
    const log = readFileSync(join(row.runDir, 'volume.log'), 'utf8')
    expect(log.startsWith('earlier line\n')).toBe(true)
    expect(log).toContain('RECOVER dev=/dev/loop77')
  })

  it('refuses a run dir whose parent anyone but the caller could rename entries in', () => {
    const groupWritable = makeRow()
    killedRun(groupWritable, { mounted: true })
    chmodSync(groupWritable.root, 0o770)
    const run = drive(groupWritable, ['--recover', '--run-dir', groupWritable.runDir], {
      tools: 'shim'
    })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain('RECOVER_REFUSED parent-writable')
    expect(groupWritable.sudoCalls()).toEqual([])

    const worldWritable = makeRow()
    killedRun(worldWritable, { mounted: true })
    chmodSync(worldWritable.root, 0o757)
    const open = drive(worldWritable, ['--recover', '--run-dir', worldWritable.runDir], {
      tools: 'shim'
    })
    expect(open.status, open.out).toBe(2)
    expect(open.out).toContain('RECOVER_REFUSED parent-writable')
    expect(worldWritable.sudoCalls()).toEqual([])
  })

  it('refuses a run dir whose parent belongs to neither the caller nor root', () => {
    const row = makeRow()
    killedRun(row, { mounted: true })
    row.resp('stat_uid_parent', '4242\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(2)
    expect(run.out).toContain('RECOVER_REFUSED parent-not-owned')
    expect(row.sudoCalls()).toEqual([])
  })

  it('accepts a sticky world-writable parent and a root-owned parent (controls for the parent checks)', () => {
    const sticky = makeRow()
    killedRun(sticky, { mounted: true })
    chmodSync(sticky.root, 0o1777)
    const stickyRun = drive(sticky, ['--recover', '--run-dir', sticky.runDir], { tools: 'shim' })
    expect(stickyRun.status, stickyRun.out).toBe(0)

    const rootOwned = makeRow()
    killedRun(rootOwned, { mounted: true })
    rootOwned.resp('stat_uid_parent', '0\n')
    const rootRun = drive(rootOwned, ['--recover', '--run-dir', rootOwned.runDir], {
      tools: 'shim'
    })
    expect(rootRun.status, rootRun.out).toBe(0)
  })

  it('refuses a marker that is not the driver nonce line', () => {
    const row = makeRow()
    foreignTarget(row)
    killedRun(row, { mounted: true })
    writeFileSync(join(row.runDir, '.real-enospc-volume.marker'), 'real-enospc-volume marker v1\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expectRefusedUntouched(row, run, 'no-marker')
  })

  it('does not unmount when losetup -j names another device for the image, even if the recorded one is mounted', () => {
    const row = makeRow()
    killedRun(row, { mounted: true })
    row.resp('losetup_j.out', '/dev/loop99: [1]:1 (/elsewhere.img)\n')
    const run = drive(row, ['--recover', '--run-dir', row.runDir], { tools: 'shim' })
    expect(run.status, run.out).toBe(5)
    expect(run.out).toContain('UMOUNT_SKIPPED image-does-not-name')
    expect(row.sudoCalls().filter((line) => /umount| -d /.test(line))).toEqual([])
  })

  it('refuses a recovery path under /tmp or without the prefix', () => {
    const row = makeRow()
    const tmpRun = drive(row, ['--recover', '--run-dir', '/tmp/p3-enospc-x'], { tools: 'shim' })
    expect(tmpRun.status).toBe(2)
    expect(tmpRun.out).toContain('REFUSED run-dir-tmp')
    const plain = drive(row, ['--recover', '--run-dir', join(row.root, 'plain')], { tools: 'shim' })
    expect(plain.status).toBe(2)
    expect(plain.out).toContain('REFUSED run-dir-prefix')
    expect(row.sudoCalls()).toEqual([])
  })
})
