import { describe, expect, it } from 'vitest'
import { planRecordedAgentResume } from './recorded-agent-resume-plan'

const SESSION = { key: 'session_id' as const, id: 'claude-session-1' }
const LINUX = { platform: 'linux' as const, shell: undefined }
const SETTINGS = {
  agentCmdOverrides: {},
  agentDefaultArgs: { claude: '--model today' },
  agentDefaultEnv: { claude: { PROFILE: 'today' } }
}

describe('planRecordedAgentResume', () => {
  it('resumes with the launch config the session was recorded with', () => {
    const plan = planRecordedAgentResume({
      agent: 'claude',
      providerSession: SESSION,
      launchConfig: { agentArgs: '--model recorded', agentEnv: { PROFILE: 'recorded' } },
      settings: SETTINGS,
      target: LINUX
    })

    expect(plan?.env).toEqual({ PROFILE: 'recorded' })
    expect(plan?.launchConfig).toMatchObject({
      agentArgs: '--model recorded',
      agentEnv: { PROFILE: 'recorded' }
    })
    expect(plan?.launchCommand).toContain("'recorded'")
    expect(plan?.launchCommand).toContain(SESSION.id)
  })

  it('falls back to the current defaults when nothing was recorded', () => {
    const plan = planRecordedAgentResume({
      agent: 'claude',
      providerSession: SESSION,
      launchConfig: undefined,
      settings: SETTINGS,
      target: LINUX
    })

    expect(plan?.env).toEqual({ PROFILE: 'today' })
    expect(plan?.launchConfig.agentArgs).toBe('--model today')
    expect(plan?.launchCommand).toContain(SESSION.id)
  })

  it('keeps a recorded empty config instead of reading today’s defaults', () => {
    const plan = planRecordedAgentResume({
      agent: 'claude',
      providerSession: SESSION,
      launchConfig: { agentArgs: '', agentEnv: {} },
      settings: SETTINGS,
      target: LINUX
    })

    expect(plan?.launchConfig).toMatchObject({ agentArgs: '', agentEnv: {} })
    expect(plan?.launchCommand).not.toContain('today')
  })

  it('forwards the recorded command and the OMP resume file', () => {
    const plan = planRecordedAgentResume({
      agent: 'omp',
      providerSession: { key: 'session_id', id: 'omp-session' },
      launchConfig: {
        agentCommand: '/opt/omp/bin/omp',
        agentArgs: '',
        agentEnv: {},
        ompResumeFilePath: '/data/omp/session.jsonl'
      },
      settings: SETTINGS,
      target: LINUX
    })

    expect(plan?.launchConfig.agentCommand).toBe('/opt/omp/bin/omp')
    expect(plan?.launchCommand).toContain('/opt/omp/bin/omp')
    expect(plan?.launchCommand).toContain('/data/omp/session.jsonl')
  })

  it('has no plan for a session the agent cannot resume exactly', () => {
    expect(
      planRecordedAgentResume({
        agent: 'pi',
        // Pi resumes only by its recorded transcript path.
        providerSession: { key: 'session_id', id: 'pi-session' },
        launchConfig: undefined,
        settings: SETTINGS,
        target: LINUX
      })
    ).toBeNull()
  })
})
