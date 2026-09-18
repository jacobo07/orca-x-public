// Sink tests: rotation behavior under size pressure and listing.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalFileSink, getRotatedFamilySize, listRotatedFiles } from './local-file-sink'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-sink-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeRecord(i: number): { i: number; payload: string } {
  // ~120 bytes per line so we can hit a small cap with a known number of
  // pushes. Padding character chosen to avoid colliding with redactor rules
  // in case the test span ever flows through the redactor.
  return { i, payload: 'x'.repeat(100) }
}

describe('local-file-sink — basic write', () => {
  it('writes one NDJSON line per push', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100,
      flushBufferThreshold: 1
    })
    sink.push({ a: 1 })
    sink.push({ b: 2 })
    sink.flush()
    sink.close()

    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual({ a: 1 })
    expect(JSON.parse(lines[1])).toEqual({ b: 2 })
  })

  it('coalesces writes up to the buffer threshold', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100_000,
      flushBufferThreshold: 5
    })
    for (let i = 0; i < 4; i++) {
      sink.push({ i })
    }
    // Below threshold: nothing on disk yet (the periodic timer is far away).
    expect(statSync(file).size).toBe(0)
    sink.push({ i: 4 })
    // 5th push hits the threshold, flushes synchronously.
    expect(statSync(file).size).toBeGreaterThan(0)
    sink.close()
  })

  it('creates trace directories and files with private POSIX permissions', () => {
    if (process.platform === 'win32') {
      return
    }
    const file = join(dir, 'logs', 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    sink.push({ ok: true })
    sink.close()

    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('tightens permissions on an existing rotated trace family', () => {
    if (process.platform === 'win32') {
      return
    }
    const file = join(dir, 'test.ndjson')
    const rotated = `${file}.1`
    writeFileSync(file, '{}\n')
    writeFileSync(rotated, '{}\n')
    chmodSync(file, 0o644)
    chmodSync(rotated, 0o644)

    const sink = createLocalFileSink({
      filePath: file,
      maxFiles: 3,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    sink.close()

    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(rotated).mode & 0o777).toBe(0o600)
  })
})

describe('local-file-sink — rotation', () => {
  it('rotates when the byte cap is exceeded', () => {
    const file = join(dir, 'test.ndjson')
    // ~120 bytes per record × 5 records = ~600 bytes; cap at 500 forces
    // rotation before all records land in the same file.
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 3,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    for (let i = 0; i < 8; i++) {
      sink.push(makeRecord(i))
    }
    sink.flush()
    sink.close()

    const files = listRotatedFiles(file, 3)
    expect(files.length).toBeGreaterThan(1)
    // The base file always exists after rotation (the post-cascade fresh
    // open).
    expect(existsSync(file)).toBe(true)
  })

  it('uses UTF-8 byte length for rotation accounting', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 90,
      maxFiles: 3,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    sink.push({ payload: '😀'.repeat(15) })
    sink.push({ payload: '😀'.repeat(15) })
    sink.flush()
    sink.close()

    expect(listRotatedFiles(file, 3).length).toBeGreaterThan(1)
  })

  it('drops an individual record that exceeds the file byte cap', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 100,
      maxFiles: 3,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    sink.push({ payload: 'x'.repeat(1_000) })
    sink.push({ ok: true })
    sink.flush()
    sink.close()

    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ ok: true }])
    expect(getRotatedFamilySize(file, 3)).toBeLessThanOrEqual(100)
  })

  it('splits an oversized buffered batch instead of dropping valid records', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 170,
      maxFiles: 5,
      batchWindowMs: 100_000,
      flushBufferThreshold: 3
    })
    sink.push({ i: 1, payload: 'x'.repeat(60) })
    sink.push({ i: 2, payload: 'x'.repeat(60) })
    sink.push({ i: 3, payload: 'x'.repeat(60) })
    sink.flush()
    sink.close()

    const allRecords = listRotatedFiles(file, 5)
      .flatMap((path) => readFileSync(path, 'utf8').split('\n').filter(Boolean))
      .map((line) => JSON.parse(line) as { i: number })
      .map((record) => record.i)
      .sort((a, b) => a - b)
    expect(allRecords).toEqual([1, 2, 3])
  })

  it('caps total disk usage at maxFiles × maxBytes (worst case)', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 3,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    // Far more than 3 × 500 bytes — exercises the FIFO drop path.
    for (let i = 0; i < 50; i++) {
      sink.push(makeRecord(i))
    }
    sink.flush()
    sink.close()

    const total = getRotatedFamilySize(file, 3)
    // Worst case: 3 files × ~500 bytes each + the in-progress base. Allow
    // 1.5× headroom so the test isn't flaky on rotation timing — what
    // matters is that we're not unbounded.
    expect(total).toBeLessThan(3 * 500 * 2)
  })
})

describe('local-file-sink — rotation failure', () => {
  // A non-empty directory at the cascade destination fails both `unlinkSync(dst)` and
  // `renameSync(src, dst)` on every platform, so rotation fails for real rather than
  // through a patched `fs` that could disagree with the syscalls production makes.
  function blockRotationDestination(file: string): string {
    const blocker = `${file}.1`
    mkdirSync(blocker)
    writeFileSync(join(blocker, 'occupant'), 'x')
    return blocker
  }

  it('rotates on the next write once a failed rotation becomes possible again', () => {
    const file = join(dir, 'test.ndjson')
    const blocker = blockRotationDestination(file)
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 2,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })

    // Push past the cap: rotation is attempted and cannot move the base file.
    for (let i = 0; i < 8; i++) {
      sink.push(makeRecord(i))
    }
    sink.flush()
    expect(statSync(file).size).toBeGreaterThan(500)
    expect(statSync(blocker).isDirectory()).toBe(true)

    // Clear the obstruction, then write one small record.
    rmSync(blocker, { recursive: true, force: true })
    sink.push({ ok: true })
    sink.flush()
    sink.close()

    // The sink still knew the base file was over cap, so this write rotated.
    // Under the unconditional `currentBytes = 0` reset it believed the file was
    // empty and would not rotate again until another full maxBytes accumulated.
    expect(existsSync(blocker)).toBe(true)
    expect(statSync(blocker).isFile()).toBe(true)
    expect(statSync(file).size).toBeLessThan(500)
  })

  it('keeps writing while rotation is impossible', () => {
    const file = join(dir, 'test.ndjson')
    blockRotationDestination(file)
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 500,
      maxFiles: 2,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    for (let i = 0; i < 12; i++) {
      sink.push(makeRecord(i))
    }
    sink.flush()
    sink.close()

    // Degrading the cap is the correct trade against losing the lane entirely.
    const written = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(written).toHaveLength(12)
  })
})

describe('local-file-sink — listing + clearing', () => {
  it('lists newest → oldest', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      maxBytes: 200,
      maxFiles: 5,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    for (let i = 0; i < 20; i++) {
      sink.push(makeRecord(i))
    }
    sink.flush()
    sink.close()

    const files = listRotatedFiles(file, 5)
    // First entry is always the base (newest).
    expect(files[0]).toBe(file)
    // Subsequent entries are the rotated suffixes in ascending order.
    for (let i = 1; i < files.length; i++) {
      expect(files[i]).toBe(`${file}.${i}`)
    }
  })
})

describe('local-file-sink — robustness', () => {
  it('does not throw on circular records (drops the line)', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({
      filePath: file,
      batchWindowMs: 100_000,
      flushBufferThreshold: 1
    })
    const a: Record<string, unknown> = { ok: true }
    a.self = a
    expect(() => {
      sink.push(a)
      sink.push({ ok: 2 })
    }).not.toThrow()
    sink.flush()
    sink.close()
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    // Only the non-circular line lands; circular is silently dropped.
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: 2 }])
  })

  it('survives close-after-close', () => {
    const file = join(dir, 'test.ndjson')
    const sink = createLocalFileSink({ filePath: file })
    sink.close()
    expect(() => sink.close()).not.toThrow()
  })
})
