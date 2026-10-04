import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from './web-preload-api-test-harness'

// IN-14 of 08-REVIEW: the web client has no agent directory. It must say so, not inherit the
// generic fallback, which resolved `undefined` for `roster` and a false empty list for `list`.
describe('web agent directory preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('answers the roster as unavailable, not as undefined', async () => {
    const { api } = await installApi('Linux')

    await expect(api.agents.roster()).resolves.toEqual({ status: 'unavailable' })
  })

  it('refuses creation as unavailable instead of resolving nothing', async () => {
    const { api } = await installApi('Linux')

    await expect(api.agents.create({ name: 'Ada', role: '', projectId: null })).resolves.toEqual({
      outcome: 'unavailable'
    })
  })

  it('does not report a false empty roster from list', async () => {
    const { api } = await installApi('Linux')

    await expect(api.agents.list()).rejects.toThrow(/desktop app/i)
  })
})
