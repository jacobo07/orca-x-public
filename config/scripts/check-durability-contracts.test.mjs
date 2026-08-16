import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main } from './check-durability-contracts.mjs'

// Why the real `main` and a real temp tree: a gate that protects a production invariant is itself
// reliability-critical. Asserting against a reimplementation of its logic would prove only that the
// reimplementation agrees with itself, which is how a gate silently stops discriminating.

const tempDirs = []

const DURABLE_WRITER = "import { writeFileDurable } from './durable-file-write'\nexport const w = 1\n"
const BARE_WRITER = "import { writeFile } from 'node:fs/promises'\nexport const w = 1\n"

function makeTempRoot(manifest, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-durability-contracts-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'config', 'durability-contracts.jsonc'), manifest, 'utf8')
  for (const [relativePath, contents] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(relativePath)), { recursive: true })
    writeFileSync(path.join(root, relativePath), contents, 'utf8')
  }
  return root
}

function validManifest(contractOverrides = {}, policyOverrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    policy: {
      tiers: ['crash-durable', 'atomic-only', 'regenerable'],
      proofRequiredForTiers: ['crash-durable'],
      durablePrimitive: 'src/main/durable-file-write.ts',
      unclassifiedWriterPolicy: 'report',
      ...policyOverrides
    },
    contracts: [
      {
        id: 'demo.state',
        state: 'demo.json',
        writer: 'src/main/demo-writer.ts',
        tier: 'crash-durable',
        lostIf: 'The demo pane forgets everything the user typed.',
        provenBy: ['src/main/demo-writer-durability.test.ts'],
        knownGaps: [],
        ...contractOverrides
      }
    ]
  })
}

const COMPLIANT_FILES = {
  'src/main/demo-writer.ts': DURABLE_WRITER,
  'src/main/demo-writer-durability.test.ts': 'export const t = 1\n'
}

describe('durability contract gate', () => {
  const errors = []

  afterEach(() => {
    errors.length = 0
    vi.restoreAllMocks()
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true })
    }
  })

  function captureErrors() {
    vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  }

  it('passes a compliant contract', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest(), COMPLIANT_FILES)
    await expect(main(root)).resolves.toBe(0)
    expect(errors).toEqual([])
  })

  it('rejects a crash-durable writer that does not route through the durable primitive', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest(), {
      ...COMPLIANT_FILES,
      'src/main/demo-writer.ts': BARE_WRITER
    })
    await expect(main(root)).resolves.toBe(1)
    // The diagnostic must name the contract and the primitive, or the failure is unactionable.
    expect(errors.join('\n')).toContain('demo.state')
    expect(errors.join('\n')).toContain('src/main/durable-file-write.ts')
  })

  it('rejects a crash-durable contract whose proof file does not exist', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest(), {
      'src/main/demo-writer.ts': DURABLE_WRITER
    })
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('proof does not exist')
  })

  it('rejects a crash-durable contract that declares no proof at all', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest({ provenBy: [] }), COMPLIANT_FILES)
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('requires a non-empty provenBy')
  })

  it('rejects a writer path that does not exist', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest(), {
      'src/main/demo-writer-durability.test.ts': 'export const t = 1\n'
    })
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('writer does not exist')
  })

  it('rejects a tier outside the declared policy', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest({ tier: 'best-effort' }), COMPLIANT_FILES)
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('tier is not one of policy.tiers')
  })

  it('rejects duplicate contract ids', async () => {
    captureErrors()
    const manifest = JSON.parse(validManifest())
    manifest.contracts.push({ ...manifest.contracts[0] })
    const root = makeTempRoot(JSON.stringify(manifest), COMPLIANT_FILES)
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('duplicate contract id')
  })

  // Why this one exists: every check above could still pass if `main` returned 0 unconditionally on
  // a malformed manifest. This proves the gate fails closed rather than skipping what it cannot read.
  it('fails closed on an unreadable manifest rather than reporting success', async () => {
    captureErrors()
    const root = mkdtempSync(path.join(tmpdir(), 'orca-durability-contracts-'))
    tempDirs.push(root)
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('unable to read manifest')
  })
})
