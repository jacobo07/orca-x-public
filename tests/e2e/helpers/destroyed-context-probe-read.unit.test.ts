import { describe, expect, it } from 'vitest'
import { readThroughDestroyedContext } from './destroyed-context-probe-read'

const DESTROYED = 'Execution context was destroyed, most likely because of a navigation'

describe('readThroughDestroyedContext', () => {
  it('resolves to the read value when the read resolves', async () => {
    // Arrange
    const read = async (): Promise<number> => 7

    // Act
    const value = await readThroughDestroyedContext(read)

    // Assert
    expect(value).toBe(7)
  })

  it('turns a destroyed execution context into "no reading yet", never into a value', async () => {
    // Arrange
    let calls = 0
    const read = async (): Promise<boolean> => {
      calls += 1
      throw new Error(DESTROYED)
    }

    // Act: the same bounded poll shape the spec runs, with its positive predicate
    const observed: (boolean | undefined)[] = []
    for (let attempt = 0; attempt < 5; attempt += 1) {
      observed.push(await readThroughDestroyedContext(read))
    }

    // Assert: every call tolerated, and none of them satisfies `=== true`
    expect(calls).toBe(5)
    expect(observed).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(observed.some((value) => value === true)).toBe(false)
  })

  it('rejects with the same error for any other failure', async () => {
    // Arrange
    const crashed = new Error('Target crashed')
    const notAnError = { code: 'EPIPE' }

    // Act / Assert
    await expect(
      readThroughDestroyedContext(async () => {
        throw crashed
      })
    ).rejects.toBe(crashed)
    await expect(
      readThroughDestroyedContext(async () => {
        throw notAnError
      })
    ).rejects.toBe(notAnError)
  })
})
