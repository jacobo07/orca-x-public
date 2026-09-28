// The defect this file pinned, now inverted in place.
//
// Orca used to answer each third-party CLI's "Do you trust this folder?" prompt on the user's
// behalf — a safety control against executing untrusted repository content, answered permanently
// and globally in the user's real home, keyed to "Orca launched an agent here". The previous
// revision of this file asserted that a workspace nobody consented to still acquired provider
// trust. Every one of those cases now asserts the opposite, against the same calls. The diff
// between the two revisions is the evidence that the boundary landed; a new file beside a deleted
// one would not be.
//
// Discriminating by construction: assertions are on the ARTIFACT ON DISK, not on a return value,
// so a guard that reports a refusal and writes anyway still fails here. Every refusal case is
// paired with a grant case in which the same call DOES write — a gate that refused everything
// would satisfy the refusals alone and is indistinguishable from a broken feature.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentTrustPreset } from './agent-trust-presets'

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
const { LOCAL_WORKSPACE_SCOPE, workspaceConsentKey } = await import('./workspace-execution-consent')

const workspaces: string[] = []

function unconsentedWorkspace(): string {
  // Why a real directory: the producers realpath() their input, and a path that does not exist
  // falls through canonicalization unresolved — a different branch than every production call site.
  //
  // Why the prefix carries no product name: the workspace path is embedded verbatim in the trust
  // artifact, so a fixture named after anything an assertion below searches for would satisfy that
  // assertion by itself. Measured: a first version prefixed 'orca-' and the absence check matched
  // the temp directory rather than the record.
  const dir = mkdtempSync(join(tmpdir(), 'unconsented-ws-'))
  workspaces.push(dir)
  return dir
}

function consentStorePath(): string {
  return join(testState.userDataDir, 'workspace-execution-consent.json')
}

/** Writes the store the product reads. Keys come from the production key builder, so a change to
 *  the key format cannot leave this harness silently granting nothing. */
function recordConsent(
  entries: {
    workspacePath: string
    preset: AgentTrustPreset
    decision: 'granted' | 'denied'
  }[]
): void {
  const grants: Record<string, { decision: string; at: string }> = {}
  for (const entry of entries) {
    grants[
      workspaceConsentKey({
        scope: LOCAL_WORKSPACE_SCOPE,
        workspacePath: entry.workspacePath,
        preset: entry.preset
      })
    ] = { decision: entry.decision, at: new Date().toISOString() }
  }
  mkdirSync(dirname(consentStorePath()), { recursive: true })
  writeFileSync(consentStorePath(), `${JSON.stringify({ version: 1, grants }, null, 2)}\n`)
}

const codexRealHomeConfig = (): string => join(testState.fakeHomeDir, '.codex', 'config.toml')
const codexManagedHomeConfig = (): string =>
  join(testState.userDataDir, 'codex-runtime-home', 'home', 'config.toml')
const cursorProjectsDir = (): string => join(testState.fakeHomeDir, '.cursor', 'projects')
const copilotConfig = (): string => join(testState.fakeHomeDir, '.copilot', 'config.json')

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

describe('a workspace nobody consented to does not acquire provider trust', () => {
  // The precondition every case below stands on, asserted rather than assumed: a harness that
  // silently pre-seeded consent would make the grant cases pass for the wrong reason.
  it('starts with no consent record and no provider artifacts', () => {
    expect(existsSync(consentStorePath())).toBe(false)
    expect(existsSync(codexRealHomeConfig())).toBe(false)
    expect(existsSync(cursorProjectsDir())).toBe(false)
    expect(existsSync(copilotConfig())).toBe(false)
  })

  it('refuses Codex trust in the real home, and says nobody was asked', () => {
    const workspace = unconsentedWorkspace()

    const outcome = markCodexProjectTrusted(workspace)

    expect(outcome).toEqual({ written: false, refusedBecause: 'unrecorded' })
    expect(existsSync(codexRealHomeConfig())).toBe(false)
  })

  it('refuses the Orca-managed CODEX_HOME too', () => {
    const workspace = unconsentedWorkspace()

    markCodexProjectTrusted(workspace)

    // Two artifacts, two homes: the managed home is what an Orca-launched Codex actually reads, so
    // a boundary that only covered the real home would leave the effect intact where it matters.
    expect(existsSync(codexManagedHomeConfig())).toBe(false)
  })

  it('refuses the Cursor per-workspace marker', () => {
    const workspace = unconsentedWorkspace()

    const outcome = markCursorWorkspaceTrusted(workspace)

    expect(outcome).toEqual({ written: false, refusedBecause: 'unrecorded' })
    expect(existsSync(cursorProjectsDir())).toBe(false)
  })

  it('refuses to add the workspace to Copilot trustedFolders', () => {
    const workspace = unconsentedWorkspace()

    const outcome = markCopilotFolderTrusted(workspace)

    expect(outcome).toEqual({ written: false, refusedBecause: 'unrecorded' })
    expect(existsSync(copilotConfig())).toBe(false)
  })
})

describe('an explicit grant still materializes the artifact', () => {
  // Without these, "refuses everything" would pass every assertion above and be indistinguishable
  // from the boundary working.
  it('writes Codex trust into both homes once consent is recorded', () => {
    const workspace = unconsentedWorkspace()
    recordConsent([{ workspacePath: workspace, preset: 'codex', decision: 'granted' }])

    const outcome = markCodexProjectTrusted(workspace)

    expect(outcome).toEqual({ written: true })
    expect(readFileSync(codexRealHomeConfig(), 'utf-8')).toContain('trust_level = "trusted"')
    expect(readFileSync(codexManagedHomeConfig(), 'utf-8')).toContain('trust_level = "trusted"')
  })

  it('writes the Cursor marker once consent is recorded', () => {
    const workspace = unconsentedWorkspace()
    recordConsent([{ workspacePath: workspace, preset: 'cursor', decision: 'granted' }])

    expect(markCursorWorkspaceTrusted(workspace)).toEqual({ written: true })
    expect(existsSync(cursorProjectsDir())).toBe(true)
  })

  it('writes Copilot trustedFolders once consent is recorded', () => {
    const workspace = unconsentedWorkspace()
    recordConsent([{ workspacePath: workspace, preset: 'copilot', decision: 'granted' }])

    expect(markCopilotFolderTrusted(workspace)).toEqual({ written: true })
    expect(JSON.parse(readFileSync(copilotConfig(), 'utf-8')).trustedFolders).toHaveLength(1)
  })
})

describe('the refusals are distinguishable, because they need different fixes', () => {
  it('reports an explicit denial as denied, not as unasked', () => {
    const workspace = unconsentedWorkspace()
    recordConsent([{ workspacePath: workspace, preset: 'codex', decision: 'denied' }])

    expect(markCodexProjectTrusted(workspace)).toEqual({
      written: false,
      refusedBecause: 'denied'
    })
    expect(existsSync(codexRealHomeConfig())).toBe(false)
  })

  it('reports a corrupt store as unreadable, and refuses rather than treating it as empty', () => {
    const workspace = unconsentedWorkspace()
    mkdirSync(dirname(consentStorePath()), { recursive: true })
    writeFileSync(consentStorePath(), '{ this is not json')

    expect(markCodexProjectTrusted(workspace)).toEqual({
      written: false,
      refusedBecause: 'unreadable'
    })
    expect(existsSync(codexRealHomeConfig())).toBe(false)
  })
})

describe('a grant covers exactly what was granted', () => {
  it('does not let consent for one provider authorize another', () => {
    const workspace = unconsentedWorkspace()
    recordConsent([{ workspacePath: workspace, preset: 'codex', decision: 'granted' }])

    expect(markCodexProjectTrusted(workspace)).toEqual({ written: true })
    expect(markCursorWorkspaceTrusted(workspace)).toEqual({
      written: false,
      refusedBecause: 'unrecorded'
    })
    expect(existsSync(cursorProjectsDir())).toBe(false)
  })

  it('does not let consent for one workspace authorize another', () => {
    const consented = unconsentedWorkspace()
    const other = unconsentedWorkspace()
    recordConsent([{ workspacePath: consented, preset: 'codex', decision: 'granted' }])

    expect(markCodexProjectTrusted(other)).toEqual({
      written: false,
      refusedBecause: 'unrecorded'
    })
    expect(existsSync(codexRealHomeConfig())).toBe(false)
  })
})
