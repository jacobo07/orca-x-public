// WL-P1-04: Playwright's `electronApp.evaluate` rejects while the main context it targets is torn down;
// right after a forced renderer crash that is "no reading yet", which a poll must try again.
const DESTROYED_CONTEXT_MESSAGE = 'Execution context was destroyed'

/** `undefined` only for the destroyed-context rejection; every other failure still fails the caller. */
export async function readThroughDestroyedContext<T>(
  read: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof Error && error.message.includes(DESTROYED_CONTEXT_MESSAGE)) {
      return undefined
    }
    throw error
  }
}
