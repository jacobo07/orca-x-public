import { describe, expect, it } from 'vitest'
import { applyHeadlessCoordinatorEnv } from './headless-coordinator-env'
import { createOrchestrationCompatibilityEnvelope } from './orchestration-compatibility-envelope'

const TOKEN = 'a'.repeat(64)

// A Sidecar launched from inside an Orca terminal inherits that terminal's identity.
const inheritedTerminalEnv = (): Record<string, string | undefined> => ({
  ORCA_TERMINAL_HANDLE: 'term_parent',
  ORCA_PANE_KEY: 'tab_parent:11111111-1111-4111-8111-111111111111',
  ORCA_AGENT_LAUNCH_TOKEN: 'launch-token',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'local',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'host-1'
})

describe('CLI headless coordinator mode (K4b)', () => {
  it('replaces every inherited terminal identity with the headless handle', () => {
    const env: Record<string, string | undefined> = {
      ...inheritedTerminalEnv(),
      ORCA_HEADLESS_COORDINATOR: 'sidecar',
      ORCA_HEADLESS_COORDINATOR_TOKEN: TOKEN
    }

    expect(applyHeadlessCoordinatorEnv(env)).toBe(true)

    expect(env.ORCA_TERMINAL_HANDLE).toBe('headless:sidecar')
    expect(env.ORCA_PANE_KEY).toBeUndefined()
    expect(env.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
    expect(env.ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID).toBeUndefined()
  })

  it('sends the token and no compatibility evidence', () => {
    const env: Record<string, string | undefined> = {
      ...inheritedTerminalEnv(),
      ORCA_HEADLESS_COORDINATOR: 'sidecar',
      ORCA_HEADLESS_COORDINATOR_TOKEN: TOKEN
    }
    applyHeadlessCoordinatorEnv(env)

    const envelope = createOrchestrationCompatibilityEnvelope(env)

    expect(envelope.orchestrationCoordinatorToken).toBe(TOKEN)
    expect(envelope.orchestrationCompatibilityEvidence).toBeUndefined()
  })

  it('changes nothing when the mode is off', () => {
    const env = inheritedTerminalEnv()

    expect(applyHeadlessCoordinatorEnv(env)).toBe(false)
    const envelope = createOrchestrationCompatibilityEnvelope(env)

    expect(env).toEqual(inheritedTerminalEnv())
    expect(envelope.orchestrationCoordinatorToken).toBeUndefined()
    expect(envelope.orchestrationCompatibilityEvidence).toMatchObject({
      terminalHandle: 'term_parent'
    })
  })
})
