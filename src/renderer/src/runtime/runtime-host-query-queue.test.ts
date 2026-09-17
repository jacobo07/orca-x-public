import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetRuntimeHostQueueForTests, runOnRuntimeHost } from './runtime-host-query-queue'

const FAR = 60_000

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('runtime host query queue', () => {
  beforeEach(() => resetRuntimeHostQueueForTests())

  it('runs one request at a time against one host', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const run = async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick()
      inFlight -= 1
      return 'ok'
    }

    const answers = await Promise.all([
      runOnRuntimeHost('host-a', Date.now() + FAR, run),
      runOnRuntimeHost('host-a', Date.now() + FAR, run),
      runOnRuntimeHost('host-a', Date.now() + FAR, run)
    ])

    expect(maxInFlight).toBe(1)
    expect(answers).toEqual(['ok', 'ok', 'ok'])
  })

  it('lets independent hosts proceed while one is busy', async () => {
    const stuck = deferred<string>()
    const busy = runOnRuntimeHost('host-a', Date.now() + FAR, () => stuck.promise)

    const free = await runOnRuntimeHost('host-b', Date.now() + FAR, async () => 'answered')

    expect(free).toBe('answered')
    stuck.resolve('late')
    await expect(busy).resolves.toBe('late')
  })

  it('answers null without running when the deadline passes first', async () => {
    const stuck = deferred<string>()
    const held = runOnRuntimeHost('host-a', Date.now() + FAR, () => stuck.promise)
    const skipped = vi.fn(async () => 'should not run')

    const gaveUp = await runOnRuntimeHost('host-a', Date.now() + 10, skipped)

    expect(gaveUp).toBeNull()
    expect(skipped).not.toHaveBeenCalled()
    stuck.resolve('done')
    await held
  })

  it('does not let a caller that gave up waiting shorten the queue', async () => {
    const stuck = deferred<string>()
    const held = runOnRuntimeHost('host-a', Date.now() + FAR, () => stuck.promise)

    // Why: this one abandons its turn, but the host is still busy with the request
    // before it — the next caller must still wait for the host, not for this one.
    expect(await runOnRuntimeHost('host-a', Date.now() + 10, async () => 'skipped')).toBeNull()

    const afterGiveUp = vi.fn(async () => 'ran')
    const queued = runOnRuntimeHost('host-a', Date.now() + FAR, afterGiveUp)
    await tick()
    expect(afterGiveUp).not.toHaveBeenCalled()

    stuck.resolve('done')
    await expect(held).resolves.toBe('done')
    await expect(queued).resolves.toBe('ran')
    expect(afterGiveUp).toHaveBeenCalledTimes(1)
  })

  it('releases the host after a request throws', async () => {
    const failing = runOnRuntimeHost('host-a', Date.now() + FAR, async () => {
      throw new Error('listing failed')
    })

    await expect(failing).rejects.toThrow('listing failed')
    await expect(runOnRuntimeHost('host-a', Date.now() + FAR, async () => 'next')).resolves.toBe(
      'next'
    )
  })

  it('does not accumulate delay for a host that has gone quiet', async () => {
    await runOnRuntimeHost('host-a', Date.now() + FAR, async () => 'first')
    await tick()

    const started = vi.fn(async () => 'second')
    const answer = runOnRuntimeHost('host-a', Date.now() + FAR, started)
    await tick()

    expect(started).toHaveBeenCalledTimes(1)
    await expect(answer).resolves.toBe('second')
  })
})
