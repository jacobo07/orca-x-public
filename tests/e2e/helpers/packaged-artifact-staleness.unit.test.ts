/**
 * What proves a packaged artifact contains the current build.
 *
 * The guard exists because `PACKAGED_ORCA_APP_DIR` is staged by hand, so a fix can be absent at
 * runtime while present in every artifact you think to inspect. The question this pins is which
 * file inside the artifact answers that — the executable carries Electron, and the asar carries the
 * application code that every one of these specs is actually about. Restaging only the asar is a
 * normal way to refresh the artifact, and it leaves the executable's timestamp where it was.
 */
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { assertPackagedArtifactIsNotStale } from './packaged-orca-app'

const SECOND = 1000

function stage(options: { exeAt: number; asarAt: number; buildAt: number }): {
  executablePath: string
  projectRoot: string
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-staleness-'))
  const appDir = path.join(root, 'win-unpacked')
  const projectRoot = path.join(root, 'repo')
  mkdirSync(path.join(appDir, 'resources'), { recursive: true })
  mkdirSync(path.join(projectRoot, 'out', 'main'), { recursive: true })
  mkdirSync(path.join(projectRoot, 'out', 'renderer'), { recursive: true })

  const write = (target: string, at: number): void => {
    writeFileSync(target, 'x')
    utimesSync(target, at / SECOND, at / SECOND)
  }
  const executablePath = path.join(appDir, 'Orca X.exe')
  write(executablePath, options.exeAt)
  write(path.join(appDir, 'resources', 'app.asar'), options.asarAt)
  write(path.join(projectRoot, 'out', 'main', 'index.js'), options.buildAt)
  write(path.join(projectRoot, 'out', 'renderer', 'index.html'), options.buildAt)
  return { executablePath, projectRoot }
}

describe('assertPackagedArtifactIsNotStale', () => {
  // The case the executable alone cannot see. Restaging the asar is how the artifact under test was
  // refreshed on this machine, and judging it by the executable refuses a current artifact — which
  // costs a full repackage to answer a question the asar had already answered.
  it('accepts an artifact whose asar is newer than the build even when the executable is not', () => {
    const { executablePath, projectRoot } = stage({
      exeAt: Date.parse('2026-09-12T21:29:00Z'),
      asarAt: Date.parse('2026-09-13T15:24:00Z'),
      buildAt: Date.parse('2026-09-13T15:19:00Z')
    })

    expect(() => assertPackagedArtifactIsNotStale(executablePath, projectRoot)).not.toThrow()
  })

  // The property the guard exists for, which the change above must not weaken: when nothing in the
  // artifact has been restaged since the build, it cannot contain it.
  it('refuses an artifact whose executable and asar both predate the build', () => {
    const { executablePath, projectRoot } = stage({
      exeAt: Date.parse('2026-09-12T21:29:00Z'),
      asarAt: Date.parse('2026-09-12T21:29:00Z'),
      buildAt: Date.parse('2026-09-13T15:19:00Z')
    })

    expect(() => assertPackagedArtifactIsNotStale(executablePath, projectRoot)).toThrow(
      /before the current build output/
    )
  })

  // An artifact with no asar beside it is not a reason to refuse: the executable is still evidence,
  // and a missing asar would fail far more loudly at launch than as a staleness verdict here.
  it('falls back to the executable when no asar sits beside it', () => {
    const { executablePath, projectRoot } = stage({
      exeAt: Date.parse('2026-09-13T15:24:00Z'),
      asarAt: Date.parse('2026-09-12T21:29:00Z'),
      buildAt: Date.parse('2026-09-13T15:19:00Z')
    })

    expect(() => assertPackagedArtifactIsNotStale(executablePath, projectRoot)).not.toThrow()
  })
})
