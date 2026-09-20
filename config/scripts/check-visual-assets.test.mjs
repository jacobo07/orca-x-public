import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT_GATE_FAILED, EXIT_INVALID, EXIT_OK, main, sha256 } from './check-visual-assets.mjs'

// Why the real `main` against a synthetic corpus: a drill pinned to a real offender has an
// interest in that offender surviving, and decays the day it is fixed. A temp tree represents
// the class, so these assertions keep working when the real registry is perfect.

const tempDirs = []
const PNG = Buffer.from('89504e470d0a1a0a-orca-visual-drill', 'utf8')
const REFERENCE_ROOT = 'docs/visual/references'

const POLICY = {
  referenceRoot: REFERENCE_ROOT,
  generatedRoot: 'docs/visual/generated',
  statuses: ['draft', 'candidate', 'approved', 'superseded', 'rejected'],
  immutableStatuses: ['approved'],
  truths: ['current', 'target'],
  producers: ['capture', 'html'],
  devices: ['desktop', 'laptop', 'tablet', 'mobile'],
  fileNamePattern: '^([a-z0-9-]+)\\.([a-z0-9-]+)\\.([a-z]+)\\.([a-z0-9-]+)\\.r([0-9]{2})\\.png$',
  minimumAssets: 0
}

function validAsset(overrides = {}) {
  return {
    assetId: 'shell.sidebar.desktop.default.r01',
    surface: 'shell',
    subsurface: 'sidebar',
    device: 'desktop',
    state: 'default',
    revision: 1,
    class: 'north-star',
    truth: 'current',
    producer: 'capture',
    status: 'approved',
    file: 'shell/shell.sidebar.desktop.default.r01.png',
    sha256: sha256(PNG),
    date: '2026-09-20',
    ...overrides
  }
}

/** Builds a temp repo root. `files` maps a path under referenceRoot to its bytes. */
function makeRoot({ manifest, assets, policy = POLICY, files, schemaVersion = 1 }) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-visual-assets-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  const body =
    manifest ?? JSON.stringify({ schemaVersion, policy, assets: assets ?? [validAsset()] })
  writeFileSync(path.join(root, 'config', 'visual-asset-registry.jsonc'), body, 'utf8')

  const tree = files ?? { 'shell/shell.sidebar.desktop.default.r01.png': PNG }
  for (const [relative, bytes] of Object.entries(tree)) {
    const full = path.join(root, REFERENCE_ROOT, relative)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, bytes)
  }
  return root
}

function run(root) {
  const errors = []
  const logs = []
  return main({ root, log: (m) => logs.push(m), error: (m) => errors.push(m) }).then((code) => ({
    code,
    text: errors.join('\n'),
    out: logs.join('\n')
  }))
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('visual asset registry gate', () => {
  it('accepts a coherent registry — the control that proves the clauses are not vacuous', async () => {
    const { code, out } = await run(makeRoot({}))
    expect(code).toBe(EXIT_OK)
    expect(out).toContain('1 asset(s)')
    expect(out).toContain('1 approved slot(s)')
  })

  it('accepts a labelled target asset', async () => {
    const { code } = await run(
      makeRoot({ assets: [validAsset({ truth: 'target', producer: 'html', targetLabel: true })] })
    )
    expect(code).toBe(EXIT_OK)
  })

  // The verdict that is about the gate, not about the corpus.
  it('reports GATE_FAILED, not INVALID, when the manifest is absent', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-visual-assets-'))
    tempDirs.push(root)
    const { code, text } = await run(root)
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(text).toContain('could not be read or parsed')
  })

  it('reports GATE_FAILED when the manifest is malformed', async () => {
    const { code, text } = await run(makeRoot({ manifest: '{ "schemaVersion": 1, ' }))
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(text).toContain('could not be read or parsed')
  })

  it('reports GATE_FAILED on an unknown schema version', async () => {
    const { code, text } = await run(makeRoot({ schemaVersion: 99 }))
    expect(code).toBe(EXIT_GATE_FAILED)
    expect(text).toContain('Unsupported registry schemaVersion')
  })

  it('strips comments and trailing whitespace like real JSONC', async () => {
    const manifest = `// leading comment with a "quoted" string
      {
        /* block comment */
        "schemaVersion": 1,
        "policy": ${JSON.stringify(POLICY)},
        "assets": [${JSON.stringify(validAsset())}] // trailing
      }`
    const { code } = await run(makeRoot({ manifest }))
    expect(code).toBe(EXIT_OK)
  })

  it('rejects a missing required field', async () => {
    const asset = validAsset()
    delete asset.date
    const { code, text } = await run(makeRoot({ assets: [asset] }))
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('missing required field "date"')
  })

  it('rejects a status outside the policy', async () => {
    const { code, text } = await run(makeRoot({ assets: [validAsset({ status: 'final' })] }))
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('status "final" is not one of')
  })

  it('rejects an unlabelled target asset', async () => {
    const { code, text } = await run(
      makeRoot({ assets: [validAsset({ truth: 'target', producer: 'html' })] })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('does not declare targetLabel: true')
  })

  it('rejects a current asset that claims a TARGET label', async () => {
    const { code, text } = await run(makeRoot({ assets: [validAsset({ targetLabel: true })] }))
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('declares a TARGET label')
  })

  it('rejects a record that contradicts its own file name', async () => {
    const { code, text } = await run(makeRoot({ assets: [validAsset({ device: 'mobile' })] }))
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('device is "mobile" in the record but "desktop" in the file name')
  })

  it('rejects a file name that does not match the naming contract', async () => {
    const { code, text } = await run(
      makeRoot({
        assets: [validAsset({ file: 'shell/final-v2.png' })],
        files: { 'shell/final-v2.png': PNG }
      })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('does not match the naming contract')
  })

  it('rejects a duplicate assetId', async () => {
    const { code, text } = await run(makeRoot({ assets: [validAsset(), validAsset()] }))
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('duplicate assetId')
  })

  it('rejects two approved assets in one slot', async () => {
    const second = validAsset({
      assetId: 'shell.sidebar.desktop.default.r02',
      revision: 2,
      file: 'shell/shell.sidebar.desktop.default.r02.png'
    })
    const { code, text } = await run(
      makeRoot({
        assets: [validAsset(), second],
        files: {
          'shell/shell.sidebar.desktop.default.r01.png': PNG,
          'shell/shell.sidebar.desktop.default.r02.png': PNG
        }
      })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('is already approved as')
  })

  it('rejects a registered asset that is missing on disk', async () => {
    const { code, text } = await run(makeRoot({ files: {} }))
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('registered but missing on disk')
  })

  // The immutability clause: the bytes moved under the people implementing from them.
  it('rejects an APPROVED asset whose bytes changed, and says to publish the next revision', async () => {
    const { code, text } = await run(
      makeRoot({
        files: { 'shell/shell.sidebar.desktop.default.r01.png': Buffer.from('tampered') }
      })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('APPROVED asset has changed on disk')
    expect(text).toContain('publish r02 as a candidate')
  })

  it('reports a plain hash mismatch for a candidate, without the immutability wording', async () => {
    const { code, text } = await run(
      makeRoot({
        assets: [validAsset({ status: 'candidate' })],
        files: { 'shell/shell.sidebar.desktop.default.r01.png': Buffer.from('tampered') }
      })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('sha256 does not match the file')
    expect(text).not.toContain('APPROVED asset has changed')
  })

  it('rejects an unregistered PNG sitting in the reference tree', async () => {
    const { code, text } = await run(
      makeRoot({
        files: {
          'shell/shell.sidebar.desktop.default.r01.png': PNG,
          'shell/shell.sidebar.desktop.stray.r01.png': PNG
        }
      })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('unregistered reference on disk')
  })

  // A floor is what tells a sweep that found nothing from an estate that has nothing.
  it('rejects a corpus that fell below its population floor', async () => {
    const { code, text } = await run(
      makeRoot({ policy: { ...POLICY, minimumAssets: 5 }, assets: [validAsset()] })
    )
    expect(code).toBe(EXIT_INVALID)
    expect(text).toContain('expected at least 5')
  })

  it('passes the floor when the corpus meets it', async () => {
    const { code } = await run(makeRoot({ policy: { ...POLICY, minimumAssets: 1 } }))
    expect(code).toBe(EXIT_OK)
  })
})
