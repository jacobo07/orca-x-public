import { fork, type ChildProcess, type ForkOptions, type SendHandle } from 'node:child_process'

/**
 * Keeps one `'message'` listener on every forked IPC child for the child's whole life.
 *
 * Node delivers IPC messages one tick after it reads them (`lib/internal/child_process.js`
 * `handleMessage` → `process.nextTick(emit, ...)`), and it checks the channel only when it
 * SCHEDULES. A tick later `emit` takes one of two branches:
 *
 *   if ('internalMessage' === event || target.listenerCount('message')) target.emit(...)
 *   else ArrayPrototypePush(target.channel[kPendingMessages], [...])   // ← node 24.18.0, line 977
 *
 * The second branch dereferences `channel`, which `disconnect()` nulls synchronously and a child
 * exit nulls on EOF. A teardown that drops the last `'message'` listener and closes the channel
 * inside that window makes node read a null channel and throw
 * `TypeError: Cannot read properties of null (reading 'Symbol(kPendingMessages)')` out of
 * `processTicksAndRejections` — uncatchable at the call site, fatal in the host process. Orca hit
 * it twice on 2026-09-17 in the Electron main process (fatal-error dialog, `main_uncaught_exception`
 * breadcrumbs at 17:24:46Z and 18:17:31Z).
 *
 * With a listener always attached, node can only take the first branch, so the crash is
 * unreachable whatever the interleaving. The floor replays what it absorbs, so the queue-until-a
 * -listener-arrives behaviour it takes away from node is not lost.
 */
type PendingMessage = [unknown, SendHandle | undefined]

// Why bounded: node's own queue is unbounded, so a child that talks to nobody grows main's heap
// forever. Every Orca site attaches its listener in the same tick as the fork, so the realistic
// depth here is zero and the cap only exists to bound a caller that never listens.
const PENDING_MESSAGE_LIMIT = 1_000

const FLOOR_INSTALLED = Symbol.for('orca.ipcMessageListenerFloor')

type FlooredChild = ChildProcess & { [FLOOR_INSTALLED]?: true }

export function installIpcMessageListenerFloor(child: ChildProcess): void {
  const floored = child as FlooredChild
  if (floored[FLOOR_INSTALLED]) {
    return
  }
  // Why the capability check: this runs at every fork, including against injected test doubles and
  // anything a library hands back. A floor that throws would be worse than the crash it prevents,
  // and an object with no listener bookkeeping cannot reach node's queue branch anyway.
  if (
    typeof child?.on !== 'function' ||
    typeof child.listeners !== 'function' ||
    typeof child.listenerCount !== 'function' ||
    typeof child.emit !== 'function'
  ) {
    return
  }
  floored[FLOOR_INSTALLED] = true

  const pending: PendingMessage[] = []
  let replaying = false
  let overflowReported = false

  const floor = (message: unknown, handle?: SendHandle): void => {
    // Why the count check: while the owner listens, node delivers to it and the floor must not
    // shadow-queue a copy that a later listener would then receive a second time.
    if (replaying || child.listenerCount('message') > 1) {
      return
    }
    if (pending.length >= PENDING_MESSAGE_LIMIT) {
      if (!overflowReported) {
        overflowReported = true
        console.warn(
          `[ipc-message-floor] dropping IPC messages for pid ${child.pid ?? 'unknown'}: nothing has listened for ${PENDING_MESSAGE_LIMIT} messages`
        )
      }
      return
    }
    pending.push([message, handle])
  }

  const onNewListener = (event: string | symbol): void => {
    if (event !== 'message' || pending.length === 0) {
      return
    }
    // Why nextTick: 'newListener' fires BEFORE the listener is added, so replaying now would emit
    // into the listener set that is missing the very listener this replay exists for.
    process.nextTick(() => {
      if (pending.length === 0 || child.listenerCount('message') <= 1) {
        return
      }
      const queued = pending.splice(0)
      replaying = true
      try {
        for (const [message, handle] of queued) {
          child.emit('message', message, handle)
        }
      } finally {
        replaying = false
      }
    })
  }

  const arm = (): void => {
    if (!child.listeners('message').includes(floor)) {
      child.on('message', floor)
    }
    if (!child.listeners('newListener').includes(onNewListener)) {
      child.on('newListener', onNewListener)
    }
  }

  // Why wrap: `removeAllListeners()` strips the floor along with the owner's listeners, and it is
  // exactly the teardown shape that precedes a kill. Re-arming synchronously inside a
  // 'removeListener' handler cannot work — EventEmitter resets its whole map afterwards.
  if (typeof child.removeAllListeners !== 'function') {
    arm()
    return
  }
  const removeAllListeners = child.removeAllListeners.bind(child)
  child.removeAllListeners = ((...args: [] | [string | symbol]) => {
    // Why the arity dance: EventEmitter branches on `arguments.length`, so forwarding an explicit
    // `undefined` turns "remove everything" into a lookup for an event named `undefined` — a
    // silent no-op that would leave a dead child's handlers attached.
    const result = args.length === 0 ? removeAllListeners() : removeAllListeners(args[0] as never)
    arm()
    return result
  }) as ChildProcess['removeAllListeners']

  arm()
}

/** `child_process.fork` with the IPC message-listener floor already installed. */
export function forkIpcChild(
  modulePath: string,
  args: readonly string[] = [],
  options: ForkOptions = {}
): ChildProcess {
  const child = fork(modulePath, [...args], options)
  installIpcMessageListenerFloor(child)
  return child
}
