import { describe, expect, it, vi } from 'vitest'
import { leafId, representativeManifest } from '../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../shared/project-working-set-types'
import {
  MAX_TRANSFER_BYTES,
  transferContinueSessions,
  type SessionTransferDeps
} from './working-set-session-transfer'

const HOME = '/home/orca-svc'
const KEY_A = `tab-a:${leafId(1)}`
const KEY_B = `tab-b:${leafId(2)}`
const SOURCE = Buffer.from('{"type":"user","cwd":"C:\\\\work\\\\orca"}\n', 'utf8')

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

/** A remote filesystem that knows only the directories and files it was given or written. */
function fakeTarget(files = new Map<string, Buffer>(), dirs = new Set(['/srv/orca'])) {
  const writes: { file: string; append: boolean }[] = []
  const target: SessionTransferDeps['target'] = {
    stat: vi.fn(async (path: string) => {
      if (dirs.has(path)) {
        return { size: 0, type: 'directory' as const, mtime: 0 }
      }
      const file = files.get(path)
      if (!file) {
        throw enoent()
      }
      return { size: file.length, type: 'file' as const, mtime: 0 }
    }),
    createDir: vi.fn(async (path: string) => {
      dirs.add(path.replace(/^~/, HOME))
    }),
    realpath: vi.fn(async (path: string) => path.replace(/^~/, HOME)),
    readFile: vi.fn(async (path: string) => {
      const file = files.get(path)
      if (!file) {
        throw enoent()
      }
      return { content: file.toString('utf8'), isBinary: false }
    }),
    writeFileBase64Chunk: vi.fn(async (path: string, base64: string, append: boolean) => {
      writes.push({ file: path, append })
      if (!append && files.has(path)) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      const chunk = Buffer.from(base64, 'base64')
      files.set(path, append ? Buffer.concat([files.get(path) ?? Buffer.alloc(0), chunk]) : chunk)
    })
  }
  return { target, files, writes }
}

function deps(target: SessionTransferDeps['target'], source: Buffer | null = SOURCE) {
  return {
    target,
    readLocal: vi.fn(async () => source ?? Buffer.alloc(0)),
    localFileSize: vi.fn(async () => (source ? source.length : null)),
    findTranscript: vi.fn(async (id: string) =>
      source ? `C:/Users/u/.claude/projects/x/${id}.jsonl` : null
    )
  } satisfies SessionTransferDeps
}

const CWDS = { [KEY_A]: '/srv/orca', [KEY_B]: '/srv/orca' }
const DEST_A = `${HOME}/.claude/projects/-srv-orca/claude-session-a.jsonl`

describe('transferContinueSessions', () => {
  it('copies a Claude transcript into the target cwd project dir and reads it back', async () => {
    const { target, files, writes } = fakeTarget()
    const out = await transferContinueSessions(representativeManifest(), CWDS, deps(target))
    expect(out[KEY_A]).toEqual({ transcript: 'present', reason: 'copied' })
    expect(files.get(DEST_A)?.equals(SOURCE)).toBe(true)
    expect(writes[0]).toEqual({ file: DEST_A, append: false })
    expect(target.createDir).toHaveBeenCalledWith('~/.claude/projects/-srv-orca')
  })

  it('counts an identical file already on the target as present, without writing', async () => {
    const { target, writes } = fakeTarget(new Map([[DEST_A, SOURCE]]))
    const out = await transferContinueSessions(representativeManifest(), CWDS, deps(target))
    expect(out[KEY_A]).toEqual({ transcript: 'present', reason: 'already-present' })
    expect(writes.filter((w) => w.file === DEST_A)).toEqual([])
  })

  it('refuses a different file under the same id and never overwrites it', async () => {
    const other = Buffer.from('{"type":"user","cwd":"/srv/orca","live":true}\n', 'utf8')
    const { target, files, writes } = fakeTarget(new Map([[DEST_A, other]]))
    const out = await transferContinueSessions(representativeManifest(), CWDS, deps(target))
    expect(out[KEY_A]).toEqual({ transcript: 'unknown', reason: 'target-conflict' })
    expect(files.get(DEST_A)).toBe(other)
    expect(writes.filter((w) => w.file === DEST_A)).toEqual([])
  })

  it('refuses a session id that could name another path, with no target call', async () => {
    const manifest: ProjectWorkingSetManifest = representativeManifest()
    const pane = manifest.entries[0].panes[0]
    if (pane.resume.kind !== 'provider-session') {
      throw new Error('fixture changed')
    }
    pane.resume.providerSession = { key: 'session_id', id: '../../.ssh/authorized_keys' }
    const { target } = fakeTarget()
    const out = await transferContinueSessions(manifest, CWDS, deps(target))
    expect(out[KEY_A]).toEqual({ transcript: 'unknown', reason: 'invalid-session-id' })
    expect(target.writeFileBase64Chunk).not.toHaveBeenCalledWith(
      expect.stringContaining('authorized_keys'),
      expect.anything(),
      expect.anything()
    )
  })

  it('reports a missing source as unknown and writes nothing', async () => {
    const { target, writes } = fakeTarget()
    const out = await transferContinueSessions(representativeManifest(), CWDS, deps(target, null))
    expect(out[KEY_A]).toEqual({ transcript: 'unknown', reason: 'source-missing' })
    expect(writes).toEqual([])
  })

  it('refuses a transcript over the size cap before reading it', async () => {
    const { target } = fakeTarget()
    const d = deps(target)
    d.localFileSize = vi.fn(async () => MAX_TRANSFER_BYTES + 1)
    const out = await transferContinueSessions(representativeManifest(), CWDS, d)
    expect(out[KEY_A]).toEqual({ transcript: 'unknown', reason: 'source-too-large' })
    expect(d.readLocal).not.toHaveBeenCalled()
  })

  it('needs the target cwd to exist and to be named', async () => {
    const { target } = fakeTarget(new Map(), new Set())
    const missing = await transferContinueSessions(representativeManifest(), CWDS, deps(target))
    expect(missing[KEY_A].reason).toBe('target-cwd-missing')
    const unnamed = await transferContinueSessions(representativeManifest(), {}, deps(target))
    expect(unnamed[KEY_A].reason).toBe('no-target-cwd')
    const windows = await transferContinueSessions(
      representativeManifest(),
      { [KEY_A]: 'C:/work/orca' },
      deps(target)
    )
    expect(windows[KEY_A].reason).toBe('no-target-cwd')
  })

  it('does not count a write that did not land as present', async () => {
    const { target } = fakeTarget()
    target.writeFileBase64Chunk = vi.fn(async () => undefined)
    const out = await transferContinueSessions(representativeManifest(), CWDS, deps(target))
    expect(out[KEY_A]).toEqual({ transcript: 'unknown', reason: 'verify-failed' })
  })

  it('leaves a non-Claude provider session alone', async () => {
    const manifest = representativeManifest()
    const pane = manifest.entries[0].panes[0]
    if (pane.resume.kind !== 'provider-session') {
      throw new Error('fixture changed')
    }
    pane.resume = { ...pane.resume, agent: 'codex' }
    const { target, writes } = fakeTarget()
    const out = await transferContinueSessions(manifest, { [KEY_A]: '/srv/orca' }, deps(target))
    expect(out[KEY_A]).toEqual({ transcript: 'unknown', reason: 'not-transferable-agent' })
    expect(writes).toEqual([])
  })
})
