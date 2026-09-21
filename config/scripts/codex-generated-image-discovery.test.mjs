import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXIT_CANNOT_LOOK,
  EXIT_OK,
  codexHomeCandidates,
  discoverGeneratedImages,
  main,
  readPngDimensions,
  resolveGeneratedImageRoot
} from './codex-generated-image-discovery.mjs'

const tempDirs = []

/** A real PNG header: signature, IHDR length, 'IHDR', then width and height big-endian. */
function pngWith(width, height, trailer = 'pixels') {
  const head = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    Buffer.alloc(8)
  ])
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return Buffer.concat([head, Buffer.from(trailer, 'utf8')])
}

function makeStore(files) {
  const home = mkdtempSync(path.join(tmpdir(), 'codex-home-'))
  tempDirs.push(home)
  const root = path.join(home, 'generated_images')
  for (const [relative, spec] of Object.entries(files)) {
    const full = path.join(root, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, spec.bytes)
    if (spec.modified) {
      const when = new Date(spec.modified)
      utimesSync(full, when, when)
    }
  }
  return { home, root }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('PNG dimensions are read, not assumed', () => {
  it('reads width and height out of IHDR', () => {
    // The observed store holds 1254x1254, 1295x1214 and 1536x1024 files. A requested size is
    // not an output size, which is the whole reason this is parsed per file.
    expect(readPngDimensions(pngWith(1254, 1254))).toEqual({ width: 1254, height: 1254 })
    expect(readPngDimensions(pngWith(1536, 1024))).toEqual({ width: 1536, height: 1024 })
  })

  it('returns null rather than a guess for anything it cannot read', () => {
    // null and 0 are different claims: one is "we could not tell", the other is a size.
    expect(readPngDimensions(Buffer.from('not a png at all'))).toBeNull()
    expect(readPngDimensions(pngWith(100, 100).subarray(0, 20))).toBeNull()
    expect(readPngDimensions(pngWith(0, 0))).toBeNull()
    const wrongChunk = pngWith(10, 10)
    wrongChunk.write('IDAT', 12, 'ascii')
    expect(readPngDimensions(wrongChunk)).toBeNull()
  })
})

describe('the store is discovered, not hardcoded', () => {
  it('prefers CODEX_HOME, then the Orca runtime home, then the standalone one', () => {
    const candidates = codexHomeCandidates(
      { CODEX_HOME: 'C:\\explicit', APPDATA: 'C:\\roaming' },
      'C:\\users\\someone'
    )
    expect(candidates[0]).toMatchObject({ path: 'C:\\explicit', source: 'CODEX_HOME' })
    expect(candidates[1].path).toContain(path.join('orca', 'codex-runtime-home', 'home'))
    expect(candidates[2].path).toContain('.codex')
  })

  it('falls through a candidate that does not exist and names what it tried', async () => {
    const { home } = makeStore({ 'thread-a/exec-1.png': { bytes: pngWith(8, 8) } })
    const resolved = await resolveGeneratedImageRoot([
      { path: path.join(home, 'nope'), source: 'missing' },
      { path: home, source: 'the real one' }
    ])
    expect(resolved.source).toBe('the real one')
    expect(resolved.tried).toHaveLength(1)
  })

  it('reports "could not look" rather than "nothing was generated"', async () => {
    // These are different facts and only one of them is about the image generation.
    const errors = []
    const code = await main({
      argv: [],
      env: { CODEX_HOME: path.join(tmpdir(), 'definitely-not-here-4a7c'), APPDATA: path.join(tmpdir(), 'nor-here-4a7c') },
      log: () => {},
      error: (m) => errors.push(String(m))
    })
    expect(code).toBe(EXIT_CANNOT_LOOK)
    expect(errors.join('\n')).toContain('could not look')
  })
})

describe('discovery', () => {
  it('attributes each image to its thread and hashes the bytes', async () => {
    const { root } = makeStore({
      'thread-a/exec-1.png': { bytes: pngWith(1254, 1254), modified: '2026-09-20T10:00:00Z' },
      'thread-b/exec-2.png': { bytes: pngWith(1536, 1024), modified: '2026-09-20T11:00:00Z' }
    })
    const images = await discoverGeneratedImages({ root })
    expect(images.map((i) => i.thread)).toEqual(['thread-a', 'thread-b'])
    expect(images[1]).toMatchObject({ width: 1536, height: 1024 })
    expect(images[0].sha256).toHaveLength(64)
    expect(images[0].sha256).not.toBe(images[1].sha256)
  })

  it('leaves isNew null when no baseline was given, instead of guessing false', async () => {
    const { root } = makeStore({ 'thread-a/exec-1.png': { bytes: pngWith(8, 8) } })
    const [image] = await discoverGeneratedImages({ root })
    expect(image.isNew).toBeNull()
  })

  it('separates what this turn produced from what was already there', async () => {
    const { root } = makeStore({
      'old/exec-old.png': { bytes: pngWith(8, 8), modified: '2026-09-01T00:00:00Z' },
      'new/exec-new.png': { bytes: pngWith(9, 9), modified: '2026-09-20T12:00:00Z' }
    })
    const images = await discoverGeneratedImages({ root, since: '2026-09-10T00:00:00Z' })
    expect(images.filter((i) => i.isNew).map((i) => i.thread)).toEqual(['new'])
  })

  it('still lists a file whose header it cannot read, with unknown dimensions', async () => {
    // A corrupt or partial artifact must not vanish from the listing: "there is a file and we
    // cannot measure it" is exactly the state a caller needs to see.
    const { root } = makeStore({ 'thread-a/exec-broken.png': { bytes: Buffer.from('truncated') } })
    const [image] = await discoverGeneratedImages({ root })
    expect(image.width).toBeNull()
    expect(image.height).toBeNull()
    expect(image.bytes).toBeGreaterThan(0)
  })
})

describe('the CLI', () => {
  it('emits machine-readable output that names the root it read', async () => {
    const { home, root } = makeStore({
      'thread-a/exec-1.png': { bytes: pngWith(1254, 1254), modified: '2026-09-20T10:00:00Z' }
    })
    const out = []
    const code = await main({
      argv: ['--json'],
      env: { CODEX_HOME: home },
      log: (m) => out.push(String(m)),
      error: () => {}
    })
    expect(code).toBe(EXIT_OK)
    const parsed = JSON.parse(out.join('\n'))
    expect(parsed.root).toBe(root)
    expect(parsed.images).toHaveLength(1)
    expect(parsed.images[0].width).toBe(1254)
  })

  it('refuses a --since it cannot parse instead of silently listing everything', async () => {
    const { home } = makeStore({ 'thread-a/exec-1.png': { bytes: pngWith(8, 8) } })
    const errors = []
    const code = await main({
      argv: ['--since', 'yesterday-ish'],
      env: { CODEX_HOME: home },
      log: () => {},
      error: (m) => errors.push(String(m))
    })
    expect(code).toBe(EXIT_CANNOT_LOOK)
    expect(errors.join('\n')).toContain('ISO timestamp')
  })
})
