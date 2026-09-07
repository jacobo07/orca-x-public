import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectUnclassifiedPublishers,
  diffBaseline,
  looksLikeAtomicPublisher,
  looksLikeDirectStateWriter,
  main,
  parseBaseline
} from './check-durability-contracts.mjs'

// Why the real `main` and a real temp tree: a gate that protects a production invariant is itself
// reliability-critical. Asserting against a reimplementation of its logic would prove only that the
// reimplementation agrees with itself, which is how a gate silently stops discriminating.

const tempDirs = []

const DURABLE_WRITER = "import { writeFileDurable } from './durable-file-write'\nexport const w = 1\n"
const BARE_WRITER = "import { writeFile } from 'node:fs/promises'\nexport const w = 1\n"
const PUBLISHER = "const tmp = `${p}.tmp`\nawait rename(tmp, p)\n"
// The exact shape of the OpenAI speech key before it was fixed: a plain write
// onto a path under the user's ~/.orca, with no temp file to announce it.
const D7_SHAPED_WRITER =
  "import { writeFileSync } from 'node:fs'\n" +
  "const keyPath = join(homedir(), '.orca', 'token.enc')\n" +
  'writeFileSync(keyPath, payload)\n'
// A real write call that is not app state. BARE_WRITER only imports the API and
// never calls it, so it would pass the destination clause without exercising it.
const NON_STATE_WRITER =
  "import { writeFileSync } from 'node:fs'\nwriteFileSync(join(outDir, 'report.pdf'), bytes)\n"

function makeTempRoot(manifest, files = {}, baseline = '', directBaseline = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-durability-contracts-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, 'config', 'durability-contracts.jsonc'), manifest, 'utf8')
  if (baseline !== null) {
    writeFileSync(path.join(root, 'config', 'durability-unclassified-baseline.txt'), baseline, 'utf8')
  }
  if (directBaseline !== null) {
    writeFileSync(
      path.join(root, 'config', 'durability-direct-writer-baseline.txt'),
      directBaseline,
      'utf8'
    )
  }
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
      unclassifiedWriterPolicy: 'ratchet',
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

  // Why: orca-data.json had a durable publisher and a bare one, and the contract read as satisfied
  // because it named only the durable one. A tier is a claim about state, so every publisher of that
  // state has to meet it — otherwise listing a second writer would weaken the contract, not tighten it.
  it('fails when any one of several writers has no barrier', async () => {
    captureErrors()
    const root = makeTempRoot(
      validManifest({ writer: ['src/main/demo-writer.ts', 'src/main/demo-transfer-writer.ts'] }),
      { ...COMPLIANT_FILES, 'src/main/demo-transfer-writer.ts': BARE_WRITER }
    )
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('src/main/demo-transfer-writer.ts')
  })

  it('passes when every listed writer carries a barrier', async () => {
    captureErrors()
    const root = makeTempRoot(
      validManifest({ writer: ['src/main/demo-writer.ts', 'src/main/demo-transfer-writer.ts'] }),
      { ...COMPLIANT_FILES, 'src/main/demo-transfer-writer.ts': DURABLE_WRITER }
    )
    await expect(main(root)).resolves.toBe(0)
    expect(errors).toEqual([])
  })

  // A second writer must leave the unclassified scan, or classifying it would still read as new debt.
  it('treats every listed writer as classified in the ratchet scan', async () => {
    captureErrors()
    const root = makeTempRoot(
      validManifest({ writer: ['src/main/demo-writer.ts', 'src/main/demo-transfer-writer.ts'] }),
      {
        ...COMPLIANT_FILES,
        'src/main/demo-transfer-writer.ts': `${DURABLE_WRITER}${PUBLISHER}`
      }
    )
    await expect(main(root)).resolves.toBe(0)
    expect(errors).toEqual([])
  })

  // Why this is accepted: integration-credential-file.ts fsyncs its handle before renaming and
  // predates the shared primitive. Failing a genuinely durable writer would be a false positive, and
  // a gate that cries wolf gets suppressed. Ordering is still proven separately by provenBy.
  it('accepts a crash-durable writer whose barrier is a hand-rolled fsync', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest(), {
      ...COMPLIANT_FILES,
      'src/main/demo-writer.ts': 'import { fsyncSync } from "node:fs"\nfsyncSync(fd)\n'
    })
    await expect(main(root)).resolves.toBe(0)
    expect(errors).toEqual([])
  })

  it('rejects a crash-durable writer with no durability barrier at all', async () => {
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
    const root = makeTempRoot(validManifest(), { 'src/main/demo-writer.ts': DURABLE_WRITER })
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

describe('durability ratchet', () => {
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

  it('fails a NEW unclassified publisher even while legacy ones are grandfathered', async () => {
    captureErrors()
    const root = makeTempRoot(
      validManifest(),
      {
        ...COMPLIANT_FILES,
        'src/main/legacy-publisher.ts': PUBLISHER,
        'src/main/brand-new-publisher.ts': PUBLISHER
      },
      'src/main/legacy-publisher.ts\n'
    )
    await expect(main(root)).resolves.toBe(1)
    const output = errors.join('\n')
    // The whole point of the ratchet: existing debt does not license more of it.
    expect(output).toContain('brand-new-publisher.ts')
    expect(output).not.toContain('::error::New unclassified durability publisher: src/main/legacy-publisher.ts')
  })

  it('passes when every publisher is grandfathered', async () => {
    captureErrors()
    const root = makeTempRoot(
      validManifest(),
      { ...COMPLIANT_FILES, 'src/main/legacy-publisher.ts': PUBLISHER },
      '# comment\nsrc/main/legacy-publisher.ts\n'
    )
    await expect(main(root)).resolves.toBe(0)
    expect(errors).toEqual([])
  })

  it('fails a stale baseline entry so the list can only shrink', async () => {
    captureErrors()
    const root = makeTempRoot(
      validManifest(),
      COMPLIANT_FILES,
      'src/main/already-classified.ts\n'
    )
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('Stale durability baseline entry')
  })

  // The aperture the OpenAI speech key slipped through: the gate keyed discovery
  // on the atomic-publish shape, so the writers with the weakest guarantee were
  // the ones it could not see. These drive the new detector's red branch.
  describe('direct state writers', () => {
    it('flags a bare write into the user data directory', () => {
      expect(looksLikeDirectStateWriter(D7_SHAPED_WRITER)).toBe(true)
    })

    it('does not flag a staged publisher, which the other ratchet already owns', () => {
      expect(looksLikeDirectStateWriter(`${D7_SHAPED_WRITER}${PUBLISHER}`)).toBe(false)
    })

    it('does not flag a write that never aims at the user data directory', () => {
      // Otherwise every PDF export and generated shell shim lands in the list,
      // and a gate that cries wolf gets suppressed rather than satisfied.
      expect(looksLikeDirectStateWriter(NON_STATE_WRITER)).toBe(false)
    })

    it('fails when a new direct state writer appears with no contract', async () => {
      captureErrors()
      const root = makeTempRoot(validManifest(), {
        ...COMPLIANT_FILES,
        'src/main/token-store.ts': D7_SHAPED_WRITER
      })
      await expect(main(root)).resolves.toBe(1)
      expect(errors.join('\n')).toContain(
        '::error::New unclassified direct state writer: src/main/token-store.ts'
      )
    })

    it('passes once that writer is named by a contract', async () => {
      captureErrors()
      const root = makeTempRoot(
        validManifest({ writer: ['src/main/demo-writer.ts', 'src/main/token-store.ts'] }),
        { ...COMPLIANT_FILES, 'src/main/token-store.ts': `${D7_SHAPED_WRITER}${DURABLE_WRITER}` }
      )
      await expect(main(root)).resolves.toBe(0)
      expect(errors).toEqual([])
    })

    it('passes with the writer grandfathered instead', async () => {
      captureErrors()
      const root = makeTempRoot(
        validManifest(),
        { ...COMPLIANT_FILES, 'src/main/token-store.ts': D7_SHAPED_WRITER },
        '',
        'src/main/token-store.ts\n'
      )
      await expect(main(root)).resolves.toBe(0)
      expect(errors).toEqual([])
    })

    it('refuses to judge when its baseline is missing rather than reporting a pass', async () => {
      // A gate that cannot read its own list has not cleared the tree.
      captureErrors()
      const root = makeTempRoot(validManifest(), COMPLIANT_FILES, '', null)
      await expect(main(root)).resolves.toBe(1)
      expect(errors.join('\n')).toContain('durability-direct-writer-baseline.txt')
    })
  })

  it('fails closed when the baseline file is absent', async () => {
    captureErrors()
    const root = makeTempRoot(validManifest(), COMPLIANT_FILES, null)
    await expect(main(root)).resolves.toBe(1)
    expect(errors.join('\n')).toContain('durability-unclassified-baseline.txt')
  })

  it('stops counting a publisher once it carries a contract', async () => {
    const manifest = JSON.parse(validManifest())
    manifest.contracts.push({
      id: 'demo.second',
      state: 'second.json',
      writer: 'src/main/legacy-publisher.ts',
      tier: 'regenerable',
      lostIf: 'Nothing; it is rebuilt from the index on next launch.',
      knownGaps: []
    })
    const root = makeTempRoot(JSON.stringify(manifest), {
      ...COMPLIANT_FILES,
      'src/main/legacy-publisher.ts': PUBLISHER
    })
    await expect(collectUnclassifiedPublishers(manifest, root)).resolves.toEqual([])
  })
})

describe('ratchet helpers', () => {
  it('recognizes the stage-then-rename publish shape', () => {
    expect(looksLikeAtomicPublisher(PUBLISHER)).toBe(true)
    expect(looksLikeAtomicPublisher('await writeFile(p, data)\n')).toBe(false)
    // A rename with no temp staging is a move, not a publish.
    expect(looksLikeAtomicPublisher('await rename(a, b)\n')).toBe(false)
  })

  it('drops comments and blank lines from the baseline', () => {
    expect(parseBaseline('# header\n\nsrc/a.ts\n')).toEqual(new Set(['src/a.ts']))
  })

  it('reports added and stale entries', () => {
    const { added, stale } = diffBaseline(['b.ts', 'c.ts'], new Set(['a.ts', 'b.ts']))
    expect(added).toEqual(['c.ts'])
    expect(stale).toEqual(['a.ts'])
  })
})
