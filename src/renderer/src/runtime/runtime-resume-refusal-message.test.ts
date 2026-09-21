import { describe, expect, it } from 'vitest'
import { runtimeResumeRefusalMessage } from './runtime-resume-refusal-message'

const rpcError = (code: string) => Object.assign(new Error(code), { code })

describe('runtimeResumeRefusalMessage', () => {
  it('names the collision instead of the raw code', () => {
    expect(runtimeResumeRefusalMessage(rpcError('agent_session_live_elsewhere'))).toMatch(
      /another pane/
    )
    expect(runtimeResumeRefusalMessage(rpcError('agent_session_multiple_live_owners'))).toMatch(
      /another pane/
    )
    expect(runtimeResumeRefusalMessage(rpcError('agent_session_materializing'))).toMatch(
      /already starting/
    )
    expect(runtimeResumeRefusalMessage(rpcError('agent_session_presence_unknown'))).toMatch(
      /couldn't confirm/
    )
  })

  it('leaves every other failure to the caller', () => {
    expect(runtimeResumeRefusalMessage(rpcError('agent_session_conflict'))).toBeNull()
    expect(runtimeResumeRefusalMessage(new Error('agent_session_materializing'))).toBeNull()
    expect(runtimeResumeRefusalMessage(null)).toBeNull()
  })
})
