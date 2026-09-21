import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CI_EVIDENCE_WITHOUT_PROVENANCE,
  findStaleProvenanceExemptions,
  main,
  resolveVerdict,
  validateManifest,
  VERDICT_CHECKER_INTERNAL_FAILURE,
  VERDICT_CONTRACT_INVALID,
  VERDICT_CONTRACT_VALID
} from './check-reliability-gates.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const tempDirs = []

function makeTempRoot(manifest) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-reliability-gates-'))
  tempDirs.push(root)
  const configDir = path.join(root, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(path.join(configDir, 'reliability-gates.jsonc'), manifest, 'utf8')
  // The fixture test file has to CONTAIN the assertion the fixture gate claims. It was empty for as
  // long as nothing dereferenced assertionRefs, which is precisely how an empty file came to satisfy
  // every claim in this suite.
  writeFileSync(
    path.join(root, 'some.test.ts'),
    "it('stale liveness snapshots do not close newer PTY bindings', () => {})\n",
    'utf8'
  )
  return root
}

function validManifest(overrides = {}) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      policy: {
        maturityLevels: ['experimental', 'soak', 'blocking', 'accepted-gap', 'deprecated'],
        blockingPromotion: {
          minimumSoakRuns: 100,
          minimumSoakDays: 14,
          maximumUnexplainedFlakes: 0
        }
      },
      gates: [
        {
          id: 'terminal-session.snapshot-freshness',
          title: 'Stale liveness snapshots cannot close newer PTY bindings',
          maturity: 'soak',
          protection: 'partial',
          owner: 'terminal-runtime',
          layer: 'renderer-unit',
          surfaces: ['terminal lifecycle'],
          platforms: ['macos', 'linux', 'windows'],
          providers: ['local', 'daemon'],
          coveredPlatforms: ['macos'],
          coveredProviders: ['local'],
          coverageNotes: 'One local macOS unit run covers the local decision-layer fixture only.',
          motivatingLinks: ['https://github.com/stablyai/orca/issues/6773'],
          invariant: 'A stale snapshot cannot close a newer binding.',
          oracle: 'The test rejects reconciliation when the binding is newer than the snapshot.',
          commands: ['pnpm exec vitest run some.test.ts'],
          testFiles: ['some.test.ts'],
          assertionRefs: [
            {
              file: 'some.test.ts',
              assertions: ['stale liveness snapshots do not close newer PTY bindings']
            }
          ],
          evidenceRuns: [
            {
              date: '2026-07-02',
              runner: 'local',
              platform: 'macos',
              command: 'pnpm exec vitest run some.test.ts',
              result: 'passed',
              durationSeconds: 1.2,
              summary: '1 file passed.'
            }
          ],
          runtimeBudget: {
            p95Seconds: 10,
            scope: 'local unit test'
          },
          flakeHistory: {
            status: 'soaking',
            evidence: 'Soak history exists.'
          },
          redGreenEvidence: {
            status: 'complete',
            evidence: 'Fails when the guard is removed and passes with the fix.'
          },
          performanceBudget: {
            required: true,
            evidence: 'Perf measurement is required before blocking promotion.'
          },
          promotionCriteria: ['Collect soak history.'],
          knownGaps: ['Needs an Electron survival test.'],
          demotionRule: 'Demote on unexplained flakes.',
          ...overrides
        }
      ]
    },
    null,
    2
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('check-reliability-gates', () => {
  it('accepts the checked-in manifest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await expect(main(process.cwd())).resolves.toBe(0)
  })

  it('rejects soak gates without executable commands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ commands: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Reliability gate manifest check failed')
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must declare at least one command')
    )
  })

  it('rejects soak gates without test files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ testFiles: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must declare at least one test file')
    )
  })

  it('rejects command-backed gates that select tests by title', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({ maturity: 'experimental', commands: ['pnpm vitest -t flaky-title'] })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('commands must not rely on title selectors')
    )
  })

  it('rejects gates without a protection level', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    delete manifest.gates[0].protection
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection must be one of none, partial, or active')
    )
  })

  it('rejects commandless gates unless they declare protection none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'partial',
        commands: [],
        testFiles: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('commandless gates must declare protection none')
    )
  })

  it('rejects command-backed gates marked as no protection', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', protection: 'none' }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare commands or testFiles')
    )
  })

  it('reserves active protection for stable blocking gates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', protection: 'active' }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection active is reserved for blocking gates')
    )
  })

  it('rejects partial gates without a passed evidence run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', evidenceRuns: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection partial gates need a passed evidence run')
    )
  })

  it('rejects evidence runs whose command is not declared by the gate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        evidenceRuns: [
          {
            date: '2026-07-02',
            runner: 'local',
            platform: 'macos',
            command: 'pnpm exec vitest run other.test.ts',
            result: 'passed',
            durationSeconds: 1,
            summary: 'Wrong command.'
          }
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('evidenceRuns[0].command must match one of the gate commands')
    )
  })

  it('rejects protection none gates with evidence runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'none',
        commands: [],
        testFiles: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare evidenceRuns')
    )
  })

  it('rejects partial gates without assertion refs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ maturity: 'experimental', assertionRefs: [] }))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection partial gates need assertionRefs')
    )
  })

  it('rejects assertion refs outside declared test files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        assertionRefs: [
          {
            file: 'other.test.ts',
            assertions: ['important invariant']
          }
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('assertionRefs[0].file must be one of the gate testFiles')
    )
  })

  it('rejects protection none gates with assertion refs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'none',
        commands: [],
        testFiles: [],
        evidenceRuns: [],
        assertionRefs: [
          {
            file: 'some.test.ts',
            assertions: ['planning entry must not look tested']
          }
        ],
        coveredPlatforms: [],
        coveredProviders: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare assertionRefs')
    )
  })

  it('rejects covered scope outside the risk scope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        coveredPlatforms: ['ios'],
        coveredProviders: ['ssh']
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('covered platform is outside risk scope: ios')
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('covered provider is outside risk scope: ssh')
    )
  })

  it('requires coveredPlatforms to include passed evidence platforms', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        coveredPlatforms: ['linux']
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('coveredPlatforms must include passed evidence platform macos')
    )
  })

  it('rejects covered scope on protection none gates', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        protection: 'none',
        commands: [],
        testFiles: [],
        evidenceRuns: [],
        coveredPlatforms: ['macos'],
        coveredProviders: [],
        flakeHistory: { status: 'not-started', evidence: 'Planning entry only.' },
        redGreenEvidence: { status: 'missing', evidence: 'No executable proof yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('protection none gates must not declare covered scope')
    )
  })

  it('rejects declared test files that do not exist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({ maturity: 'experimental', testFiles: ['missing.test.ts'] })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('test file does not exist: missing.test.ts')
    )
  })

  it('rejects executable gates whose commands do not reference declared test files', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const command = 'pnpm exec vitest run'
    const root = makeTempRoot(
      validManifest({
        maturity: 'experimental',
        commands: [command],
        evidenceRuns: [
          {
            date: '2026-07-02',
            runner: 'local',
            platform: 'macos',
            command,
            result: 'passed',
            durationSeconds: 1,
            summary: 'Command did not name the declared file.'
          }
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('test file is not referenced by any gate command: some.test.ts')
    )
  })

  it('rejects soak gates without mature flake and red/green evidence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        flakeHistory: { status: 'unknown', evidence: 'No soak yet.' },
        redGreenEvidence: { status: 'partial', evidence: 'No saved artifact yet.' }
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must have soaking or stable flakeHistory')
    )
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('soak gates must have complete red/green evidence')
    )
  })

  // Why: every other rejection case supplies a well-formed but wrong value, so none of them
  // reaches a validator that reads a field an earlier validator already rejected. An absent
  // field is the shape a hand-edited manifest actually takes.
  it('reports an absent required field instead of failing as the checker', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    delete manifest.gates[0].evidenceRuns
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('evidenceRuns must be an array')
    )
  })

  it('rejects malformed JSONC', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot('{ "schemaVersion": 1, } trailing')

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('JSONC parse error'))
  })

  it('rejects missing manifests with a structured error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = mkdtempSync(path.join(tmpdir(), 'orca-reliability-gates-'))
    tempDirs.push(root)

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('unable to read manifest'))
  })

  it('uses policy maturity levels as the source of truth', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    manifest.policy.maturityLevels = ['experimental']
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('maturity is invalid'))
  })

  it('rejects malformed blocking promotion policy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const manifest = JSON.parse(validManifest())
    manifest.policy.blockingPromotion.maximumUnexplainedFlakes = -1
    const root = makeTempRoot(JSON.stringify(manifest, null, 2))

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'policy.blockingPromotion.maximumUnexplainedFlakes must be a non-negative number'
      )
    )
  })

  // Why: the positive control for the internal-failure branch. Without an input that genuinely
  // throws, a checker that had stopped catching would report the same clean green as one that
  // still does. A getter is the only way to build a throwing field a JSONC file cannot express —
  // which is the point, since the branch exists for field shapes nobody anticipated.
  it('reports a throwing validator as a checker failure, not as an invalid contract', async () => {
    const manifest = JSON.parse(validManifest())
    Object.defineProperty(manifest.gates[0], 'evidenceRuns', {
      configurable: true,
      get() {
        throw new Error('field access exploded')
      }
    })

    const result = await validateManifest(manifest, process.cwd())

    expect(result.internalFailures).toHaveLength(1)
    expect(result.internalFailures[0]).toContain('terminal-session.snapshot-freshness')
    expect(result.internalFailures[0]).toContain('field access exploded')
    expect(resolveVerdict(result)).toEqual({
      verdict: VERDICT_CHECKER_INTERNAL_FAILURE,
      code: 2
    })
  })

  it('lets a checker failure outrank contract failures found in the same run', () => {
    // A run that could not judge every gate proves nothing about the ones it skipped, so it must
    // not report as a plain rejection — that would claim the manifest was fully examined.
    expect(resolveVerdict({ failures: [], internalFailures: [] })).toEqual({
      verdict: VERDICT_CONTRACT_VALID,
      code: 0
    })
    expect(resolveVerdict({ failures: ['a gate is wrong'], internalFailures: [] })).toEqual({
      verdict: VERDICT_CONTRACT_INVALID,
      code: 1
    })
    expect(
      resolveVerdict({ failures: ['a gate is wrong'], internalFailures: ['a gate threw'] })
    ).toEqual({ verdict: VERDICT_CHECKER_INTERNAL_FAILURE, code: 2 })
  })

  it('names unreadable input as its own verdict rather than an invalid contract', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot('{ "schemaVersion": 1, } trailing')

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('UNREADABLE INPUT'))
  })
})

/**
 * The subject in every case below is a SYNTHETIC gate, never a real one. A drill aimed at a real
 * offender has an interest in that offender surviving and asserts nothing the day it is fixed --
 * and this baseline is meant to shrink to empty, which would leave such a drill with no subject.
 */
function withBaseline(root, text) {
  writeFileSync(path.join(root, 'config', 'reliability-assertion-baseline.txt'), text, 'utf8')
  return root
}

function citingAnUnrelatedTest(root) {
  writeFileSync(
    path.join(root, 'some.test.ts'),
    "it('an entirely different test', () => {})\n",
    'utf8'
  )
  return root
}

describe('assertion evidence must name something that exists', () => {
  it('refuses a gate whose claimed assertion appears nowhere in the file it cites', async () => {
    const root = citingAnUnrelatedTest(makeTempRoot(validManifest()))

    await expect(main(root)).resolves.toBe(1)
  })

  // The green half. Without it a resolver that flagged everything would pass every red case here
  // and read exactly like a working detector.
  it('accepts a gate whose claimed assertion is present', async () => {
    const root = makeTempRoot(validManifest())

    await expect(main(root)).resolves.toBe(0)
  })

  it('accepts recorded legacy debt so the gate is not red on arrival', async () => {
    const root = withBaseline(
      citingAnUnrelatedTest(makeTempRoot(validManifest())),
      '# legacy\nterminal-session.snapshot-freshness 1\n'
    )

    await expect(main(root)).resolves.toBe(0)
  })

  it('refuses debt that grew beyond its recorded count', async () => {
    const root = withBaseline(
      citingAnUnrelatedTest(
        makeTempRoot(
          validManifest({
            assertionRefs: [
              { file: 'some.test.ts', assertions: ['one missing claim', 'a second missing claim'] }
            ]
          })
        )
      ),
      'terminal-session.snapshot-freshness 1\n'
    )

    await expect(main(root)).resolves.toBe(1)
  })

  it('refuses a baseline entry for a gate that now resolves, so the list cannot outlive its debt', async () => {
    const root = withBaseline(
      makeTempRoot(validManifest()),
      'terminal-session.snapshot-freshness 1\n'
    )

    await expect(main(root)).resolves.toBe(1)
  })

  it('separates a baseline it cannot parse from a manifest it rejected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = withBaseline(makeTempRoot(validManifest()), 'this is not an entry\n')

    await expect(main(root)).resolves.toBe(2)
  })
})

describe('a ci evidence run must name the run', () => {
  const ciRun = (overrides = {}) => ({
    date: '2026-09-20',
    runner: 'ci',
    platform: 'macos',
    command: 'pnpm exec vitest run some.test.ts',
    result: 'passed',
    durationSeconds: 1.2,
    summary: '1 file passed.',
    ...overrides
  })

  it('rejects a ci run with no runUrl', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(validManifest({ evidenceRuns: [ciRun()] }))

    await expect(main(root)).resolves.toBe(1)
  })

  // Green control. Without it, a clause that refused every ci run would pass the case above.
  it('accepts a ci run that carries a GitHub Actions run URL', async () => {
    const root = makeTempRoot(
      validManifest({
        evidenceRuns: [
          ciRun({ runUrl: 'https://github.com/jacobo07/orca-x/actions/runs/34726494245' })
        ]
      })
    )

    await expect(main(root)).resolves.toBe(0)
  })

  it('rejects a runUrl that is not an Actions run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const runUrl of [
      'https://github.com/jacobo07/orca-x/actions',
      'https://example.com/jacobo07/orca-x/actions/runs/1',
      'https://github.com/jacobo07/orca-x/actions/runs/not-a-number',
      ''
    ]) {
      const root = makeTempRoot(validManifest({ evidenceRuns: [ciRun({ runUrl })] }))
      await expect(main(root)).resolves.toBe(1)
    }
  })

  // The requirement is about ci only. Nothing outside this repository witnessed a local run, so
  // demanding provenance there would be asking for evidence that cannot exist.
  it('asks nothing of local, soak or manual runs', async () => {
    for (const runner of ['local', 'soak', 'manual']) {
      const root = makeTempRoot(validManifest({ evidenceRuns: [ciRun({ runner })] }))
      await expect(main(root)).resolves.toBe(0)
    }
  })

  // Regression pin: the frozen list names gates in THIS repository's manifest. Judging a synthetic
  // manifest against it read every exemption as stale and failed fixtures that have nothing to do
  // with provenance.
  it('does not judge a manifest that does not contain the exempted gates', () => {
    expect(findStaleProvenanceExemptions({ gates: [{ id: 'unrelated.gate', evidenceRuns: [] }] })).toEqual([])
    expect(findStaleProvenanceExemptions({})).toEqual([])
  })

  // Mutating the function is not enough: the two cases below call it directly, so severing the
  // CALL from validateManifest left them green. This one drives the wiring, and it asserts on the
  // reason, because a manifest can exit 1 for a dozen unrelated causes.
  it('reaches the stale check from the checker itself, not just from a direct call', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const root = makeTempRoot(
      validManifest({
        id: 'browser-stream.bounded-reconnect',
        evidenceRuns: [
          ciRun({
            date: '2026-08-07',
            runUrl: 'https://github.com/jacobo07/orca-x/actions/runs/34726494245'
          })
        ]
      })
    )

    await expect(main(root)).resolves.toBe(1)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('exempted from ci evidence provenance')
    )
  })

  // Drives the stale branch, which nothing else reaches: against the real manifest the list is
  // never stale, so without this the whole clause could be deleted and every case here would
  // still pass. Uses a really-exempted id, because the branch is keyed to those ids.
  it('refuses an exemption whose run has since gained provenance', () => {
    expect(
      findStaleProvenanceExemptions({
        gates: [
          {
            id: 'browser-stream.bounded-reconnect',
            evidenceRuns: [
              {
                date: '2026-08-07',
                runner: 'ci',
                runUrl: 'https://github.com/jacobo07/orca-x/actions/runs/34726494245'
              }
            ]
          }
        ]
      })
    ).toEqual(['browser-stream.bounded-reconnect::2026-08-07'])
  })

  it('refuses an exemption whose run no longer exists at all', () => {
    expect(
      findStaleProvenanceExemptions({
        gates: [{ id: 'browser-stream.bounded-reconnect', evidenceRuns: [] }]
      })
    ).toEqual(['browser-stream.bounded-reconnect::2026-08-07'])
  })

  // The checker deliberately cannot police the real manifest from inside a synthetic one, so the
  // real file is pinned here: the exemption set and the set of unproven ci runs must be equal.
  // One direction stops the list rotting, the other stops it being padded.
  it('matches this repository exactly, in both directions', async () => {
    const raw = await readFile(path.join(REPO_ROOT, 'config', 'reliability-gates.jsonc'), 'utf8')
    const manifest = parseJsonc(raw)
    const unproven = new Set()
    for (const gate of manifest.gates) {
      for (const run of gate.evidenceRuns ?? []) {
        if (run.runner === 'ci' && !/\/actions\/runs\/\d+$/.test(run.runUrl ?? '')) {
          unproven.add(`${gate.id}::${run.date}`)
        }
      }
    }
    expect([...unproven].sort()).toEqual([...CI_EVIDENCE_WITHOUT_PROVENANCE].sort())
    expect(findStaleProvenanceExemptions(manifest)).toEqual([])
  })
})
