import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FAKE_DEV, drive, linux, makeRow, runArgs, sha } from './real-enospc-volume-shim-driver.mjs'

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
