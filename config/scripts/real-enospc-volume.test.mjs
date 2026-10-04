import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  FAKE_DEV,
  SCRIPT,
  drive,
  linux,
  makeRow,
  runArgs,
  sha
} from './real-enospc-volume-shim-driver.mjs'

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
