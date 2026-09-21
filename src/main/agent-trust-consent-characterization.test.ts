// Characterization of the defect the workspace-execution-consent boundary exists to remove.
//
// Today Orca answers a third-party CLI's "Do you trust this folder?" prompt on the user's behalf.
// That prompt is a safety control against executing untrusted repository content; the artifact is
// written into the user's REAL home, permanently, globally, and is still in force when they run the
// CLI from a plain terminal months later. It is keyed to "Orca launched an agent here", never to
// "the user trusts this folder".
//
// These assertions pin CURRENT behaviour: with no consent recorded anywhere, every preset writes.
// When the consent authority lands, this file inverts in place — same calls, no consent, nothing
// written — and the diff between the two versions is the evidence. A new test beside a deleted one
// would not be.
//
// Discriminating by construction: each case asserts on the ARTIFACT ON DISK, not on a helper's
// return value. A guard that returns early but still writes, or writes to a different path, fails
// here; a lexical "does it call the authority" check would not.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = {
  fakeHomeDir: '',
  userDataDir: '',
  previousUserDataPath: undefined as string | undefined
}

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') {
        return testState.userDataDir
      }
      throw new Error(`unexpected app.getPath(${name})`)
    }
  }
}))

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const { markCodexProjectTrusted, markCopilotFolderTrusted, markCursorWorkspaceTrusted } =
  await import('./agent-trust-presets')

const workspaces: string[] = []

function unconsentedWorkspace(): string {
  // Why a real directory: the producers realpath() their input, and a path that does not exist
  // falls through canonicalize() unresolved — which would exercise a different branch than the one
  // every production call site takes.
  //
  // Why the prefix carries no product name: the workspace path is embedded verbatim in the trust
  // artifact, so a fixture named after anything an assertion below searches for would satisfy that
  // assertion by itself. Measured: a first version prefixed 'orca-' and the absence check matched
  // the temp directory rather than the record.
  const dir = mkdtempSync(join(tmpdir(), 'unconsented-ws-'))
  workspaces.push(dir)
  return dir
}

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-trust-consent-home-'))
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-consent-user-data-'))
  testState.previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
})

afterEach(() => {
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  rmSync(testState.userDataDir, { recursive: true, force: true })
  while (workspaces.length > 0) {
    rmSync(workspaces.pop() as string, { recursive: true, force: true })
  }
  if (testState.previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = testState.previousUserDataPath
  }
  testState.fakeHomeDir = ''
  testState.userDataDir = ''
  testState.previousUserDataPath = undefined
})

describe('a workspace nobody consented to still acquires provider trust', () => {
  // The precondition every case below stands on. Stated as its own assertion so a harness that
  // silently pre-seeded consent could not make the rest of the file pass for the wrong reason.
  it('starts with no consent record anywhere in the profile or the home', () => {
    expect(readdirSync(testState.userDataDir)).toEqual([])
    expect(readdirSync(testState.fakeHomeDir)).toEqual([])
  })

  it('writes Codex project trust into the real home config.toml', () => {
    const workspace = unconsentedWorkspace()

    markCodexProjectTrusted(workspace)

    const configPath = join(testState.fakeHomeDir, '.codex', 'config.toml')
    expect(existsSync(configPath)).toBe(true)
    expect(readFileSync(configPath, 'utf-8')).toContain('trust_level = "trusted"')
  })

  it('writes Codex project trust into the Orca-managed CODEX_HOME as well', () => {
    const workspace = unconsentedWorkspace()

    markCodexProjectTrusted(workspace)

    // Two artifacts, two homes, one unconsented call: the managed home is what an Orca-launched
    // Codex actually reads, so a fix that only covers the real home would leave the effect intact.
    const managed = join(
      testState.userDataDir,
      'codex-runtime-home',
      'home',
      'config.toml'
    )
    expect(existsSync(managed)).toBe(true)
    expect(readFileSync(managed, 'utf-8')).toContain('trust_level = "trusted"')
  })

  it('writes the Cursor per-workspace trust marker', () => {
    const workspace = unconsentedWorkspace()

    markCursorWorkspaceTrusted(workspace)

    const projectsDir = join(testState.fakeHomeDir, '.cursor', 'projects')
    const slugs = readdirSync(projectsDir)
    expect(slugs.length).toBe(1)
    expect(existsSync(join(projectsDir, slugs[0], '.workspace-trusted'))).toBe(true)
  })

  it('adds the workspace to Copilot trustedFolders', () => {
    const workspace = unconsentedWorkspace()

    markCopilotFolderTrusted(workspace)

    const configPath = join(testState.fakeHomeDir, '.copilot', 'config.json')
    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(Array.isArray(config.trustedFolders)).toBe(true)
    expect(config.trustedFolders).toHaveLength(1)
  })

  // The blast radius, stated as a measurement rather than a sentence: the grant is global and
  // outlives the launch that caused it. Nothing scopes it to Orca, to this session, or to a period.
  it('leaves a grant that survives after the launch that caused it is over', () => {
    const workspace = unconsentedWorkspace()

    markCodexProjectTrusted(workspace)
    const afterLaunch = readFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), 'utf-8')

    expect(afterLaunch).toContain('trust_level = "trusted"')
    // Nothing bounds the grant: no expiry, no issuing session, no Orca-scoping key. Anchored to
    // key position (`^key =`) rather than a bare substring, because the workspace path is written
    // into this same file and would otherwise answer the search on the record's behalf.
    expect(afterLaunch).not.toMatch(/^\s*(expires|expires_at|granted_by|granted_at|session_id)\s*=/m)
  })
})
