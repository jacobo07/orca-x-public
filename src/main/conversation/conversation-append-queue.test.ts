// Deterministic proof of the two properties the queue exists for. Deliberately not timing-based:
// on a loaded host a duration proves nothing, so overlap is proven by observing that one key's work
// entered while another key's work was still suspended on a promise this test controls.
import { describe, expect, it } from 'vitest'

import { ConversationAppendQueue } from './conversation-append-queue'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('work for one conversation', () => {
  it('does not start until the previous entry for that conversation has settled', async () => {
    const queue = new ConversationAppendQueue()
    const gate = deferred()
    const order: string[] = []

    const first = queue.run('conv-a', async () => {
      order.push('first:enter')
      await gate.promise
      order.push('first:exit')
    })
    const second = queue.run('conv-a', async () => {
      order.push('second:enter')
    })

    // Flush microtasks. If the queue were not serializing, second:enter would already be recorded.
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['first:enter'])

    gate.resolve()
    await Promise.all([first, second])

    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter'])
  })

  it('still runs the next entry when the previous one rejected', async () => {
    const queue = new ConversationAppendQueue()
    let ran = false

    const failing = queue.run('conv-a', async () => {
      throw new Error('fold blew up')
    })
    const following = queue.run('conv-a', async () => {
      ran = true
      return 'ok'
    })

    await expect(failing).rejects.toThrow('fold blew up')
    // A failed append is one operation failing, not a reason to wedge the conversation forever.
    await expect(following).resolves.toBe('ok')
    expect(ran).toBe(true)
  })
})

describe('work for different conversations', () => {
  it('overlaps instead of queueing behind each other', async () => {
    const queue = new ConversationAppendQueue()
    const gate = deferred()
    let bEnteredWhileAWasOpen = false
    let aOpen = false

    const a = queue.run('conv-a', async () => {
      aOpen = true
      await gate.promise
      aOpen = false
    })
    const b = queue.run('conv-b', async () => {
      bEnteredWhileAWasOpen = aOpen
    })

    await b
    // The negative control for this assertion is the same-key case above, which shows the second
    // entry cannot start. If both keys serialized, this would be false.
    expect(bEnteredWhileAWasOpen).toBe(true)

    gate.resolve()
    await a
  })

  it('forgets a conversation once its queue drains, so the map does not grow forever', async () => {
    const queue = new ConversationAppendQueue()

    await queue.run('conv-a', async () => undefined)
    await queue.run('conv-b', async () => undefined)
    // The prune runs in a then() on the settled chain, so let it land.
    await Promise.resolve()
    await Promise.resolve()

    expect(queue.pendingKeys).toEqual([])
  })
})
