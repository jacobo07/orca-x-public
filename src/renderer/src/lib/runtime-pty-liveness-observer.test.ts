import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { SampledRuntimePtyLiveness } from './agent-hibernation-planner-snapshot'
import { createRuntimePtyLivenessObserver } from './runtime-pty-liveness-observer'

function sampleOf(ptyId: string): SampledRuntimePtyLiveness {
  return {
    runtimeLivePtyIdsByWorktreeId: { 'wt-a': [ptyId] },
    environmentIdByWorktreeId: { 'wt-a': 'runtime-1' }
  }
}

function manualSampler() {
  const answers: ((sample: SampledRuntimePtyLiveness) => void)[] = []
  const sample = vi.fn(
    () => new Promise<SampledRuntimePtyLiveness>((resolve) => answers.push(resolve))
  )
  return { sample, answers }
}

const state = {} as AppState

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createRuntimePtyLivenessObserver', () => {
  it('delivers the answer to the current request', async () => {
    const { sample, answers } = manualSampler()
    const onSample = vi.fn()
    createRuntimePtyLivenessObserver(onSample, sample).request(state)

    answers[0](sampleOf('pty-1'))
    await flush()

    expect(onSample).toHaveBeenCalledWith(sampleOf('pty-1'))
  })

  it('drops an older answer that arrives after a newer request, even uncancelled', async () => {
    const { sample, answers } = manualSampler()
    const onSample = vi.fn()
    const observer = createRuntimePtyLivenessObserver(onSample, sample)
    observer.request(state)
    observer.request(state)

    answers[1](sampleOf('pty-new'))
    await flush()
    answers[0](sampleOf('pty-old'))
    await flush()

    expect(onSample.mock.calls).toEqual([[sampleOf('pty-new')]])
  })

  it('drops the answer of a cancelled request', async () => {
    const { sample, answers } = manualSampler()
    const onSample = vi.fn()
    const cancel = createRuntimePtyLivenessObserver(onSample, sample).request(state)

    cancel()
    answers[0](sampleOf('pty-1'))
    await flush()

    expect(onSample).not.toHaveBeenCalled()
  })
})
