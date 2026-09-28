import type { ElectronApplication } from '@stablyai/playwright-test'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

// Why: a provider pointer the runner does not hold makes the absence below vacuous. Set before the
// fixture reads process.env, restored after, so no other spec in this worker inherits it.
const PROVIDER_SENTINEL_KEY = 'CLAUDE_CONFIG_DIR'
const previousSentinel = process.env[PROVIDER_SENTINEL_KEY]
process.env[PROVIDER_SENTINEL_KEY] = path.join(path.sep, 'orca-e2e-sentinel', 'claude-config')
test.afterAll(() => {
  if (previousSentinel === undefined) {
    delete process.env[PROVIDER_SENTINEL_KEY]
  } else {
    process.env[PROVIDER_SENTINEL_KEY] = previousSentinel
  }
})

async function readElectronHomeState(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ app }) => {
    const nodeOs = process.getBuiltinModule('node:os')
    return {
      appHome: app.getPath('home'),
      nodeHome: nodeOs.homedir(),
      userDataDir: process.env.ORCA_E2E_USER_DATA_DIR,
      home: process.env.HOME,
      userProfile: process.env.USERPROFILE,
      codexHome: process.env.CODEX_HOME,
      orcaCodexHome: process.env.ORCA_CODEX_HOME,
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY
    }
  })
}

// Codex always routes to the real home now, so this single case covers both the
// HOME boundary and that real-home routing lands inside the disposable profile.
test('isolates Electron and Codex from the developer home by default', async ({ electronApp }) => {
  const state = await readElectronHomeState(electronApp)
  const expectedHome = path.join(state.userDataDir!, 'home')

  expect(state.appHome).toBe(expectedHome)
  expect(state.nodeHome).toBe(expectedHome)
  expect(state.home).toBe(expectedHome)
  expect(state.userProfile).toBe(expectedHome)
  expect(state.codexHome).toBeUndefined()
  expect(state.orcaCodexHome).toBeUndefined()
  // Station control: the runner held the pointer at launch, so its absence is the boundary's.
  expect(process.env[PROVIDER_SENTINEL_KEY]).toBeTruthy()
  expect(state.claudeConfigDir).toBeUndefined()
  expect(state.anthropicApiKey).toBeUndefined()
})
