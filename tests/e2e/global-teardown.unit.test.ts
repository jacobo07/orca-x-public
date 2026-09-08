/**
 * Teardown is the last thing a run does, so its failures are the ones most likely to be
 * misread: everything has already been measured, and an exception here rewrites the exit code
 * of a suite that passed.
 *
 * These drive the three properties that keep that from happening — cleanup cannot throw,
 * cleanup cannot leak its own marker, and cleanup cannot delete what it has not proven it owns.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { failingRemovals } = vi.hoisted(() => ({ failingRemovals: new Set<string>() }))

// Only rmSync is faked, and only for paths a test explicitly arms. Windows raises EPERM here
// when a just-closed Electron profile still holds handles; that is observed behaviour, and this
// is how the branch it takes gets driven on any platform.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    default: actual,
    rmSync: (target: Parameters<typeof actual.rmSync>[0], options?: object) => {
      if (typeof target === 'string' && failingRemovals.has(target.toLowerCase())) {
        throw new Error(`EPERM: operation not permitted, unlink '${target}'`)
      }
      return actual.rmSync(target, options)
    }
  }
})

function gitIsAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const HAS_GIT = gitIsAvailable()

type TeardownWorld = {
  markerFile: string
  repoDir: string
  ownedWorktree: string
  foreignWorktree: string
}

function seedWorld(): TeardownWorld {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'orca-teardown-unit-'))
  const repoDir = path.join(parent, 'orca-e2e-repo-unit')
  mkdirSync(repoDir, { recursive: true })
  const ownedWorktree = path.join(parent, 'orca-e2e-worktree-owned')
  // Named exactly like something this run would have made, but attached to no repository of
  // ours — a concurrent run's live worktree looks precisely like this from the outside.
  const foreignWorktree = path.join(parent, 'orca-e2e-worktree-foreign')
  mkdirSync(foreignWorktree, { recursive: true })
  writeFileSync(path.join(foreignWorktree, 'another-run-is-using-this.txt'), 'live\n')

  if (HAS_GIT) {
    const git = (args: string[], cwd: string): void => {
      execFileSync('git', args, { cwd, stdio: 'pipe' })
    }
    git(['init'], repoDir)
    git(['config', 'user.email', 'teardown@test.local'], repoDir)
    git(['config', 'user.name', 'Teardown Unit'], repoDir)
    writeFileSync(path.join(repoDir, 'README.md'), '# seed\n')
    git(['add', '-A'], repoDir)
    git(['commit', '-m', 'seed'], repoDir)
    git(['worktree', 'add', ownedWorktree, '-b', 'teardown-unit-secondary'], repoDir)
  }

  const markerFile = path.join(parent, 'orca-e2e-test-repo-path-unit.txt')
  writeFileSync(markerFile, repoDir)
  return { markerFile, repoDir, ownedWorktree, foreignWorktree }
}

async function runTeardown(markerFile: string): Promise<void> {
  process.env.ORCA_E2E_TEST_REPO_PATH_FILE = markerFile
  vi.resetModules()
  const { default: globalTeardown } = await import('./global-teardown')
  await globalTeardown()
}

describe('globalTeardown', () => {
  let world: TeardownWorld
  let errors: string[]

  beforeEach(() => {
    failingRemovals.clear()
    world = seedWorld()
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_E2E_TEST_REPO_PATH_FILE
  })

  it('removes the repository and marker it created', async () => {
    await runTeardown(world.markerFile)

    expect(existsSync(world.repoDir)).toBe(false)
    expect(existsSync(world.markerFile)).toBe(false)
  })

  it('does not throw when the platform still holds the profile it is removing', async () => {
    // The subject verdict is already decided by the time this runs. An exception here replaces it.
    failingRemovals.add(world.repoDir.toLowerCase())

    await expect(runTeardown(world.markerFile)).resolves.toBeUndefined()
  })

  it('removes its own marker even after the repository removal failed', async () => {
    // Today the throw skips the marker removal, so a failed cleanup leaks twice over.
    failingRemovals.add(world.repoDir.toLowerCase())

    await runTeardown(world.markerFile)

    expect(existsSync(world.markerFile)).toBe(false)
  })

  it('names the failure as a cleanup failure so a sick harness stays visible', async () => {
    // Not swallowed: a cleanup that keeps failing is a harness health problem, and the run has
    // to say so. What it must not do is say the product failed.
    failingRemovals.add(world.repoDir.toLowerCase())

    await runTeardown(world.markerFile)

    expect(errors.join('\n')).toContain('cleanup-failed')
  })

  it.skipIf(!HAS_GIT)('removes a worktree of its own repository', async () => {
    expect(existsSync(world.ownedWorktree)).toBe(true)

    await runTeardown(world.markerFile)

    expect(existsSync(world.ownedWorktree)).toBe(false)
  })

  it('leaves a same-named worktree it cannot prove it owns', async () => {
    // A prefix match in a shared temp directory cannot tell this run's worktree from a
    // concurrent run's live one. Deleting under someone else's feet is worse than leaking.
    await runTeardown(world.markerFile)

    expect(existsSync(world.foreignWorktree)).toBe(true)
    expect(readFileSync(path.join(world.foreignWorktree, 'another-run-is-using-this.txt'), 'utf8')).toBe(
      'live\n'
    )
  })
})
