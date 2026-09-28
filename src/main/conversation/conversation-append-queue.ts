// Per-conversation serialization for the durable conversation writer.
//
// Why per conversation and not one global lock: two people, two panes, or later two Council members
// writing to DIFFERENT conversations have nothing to contend over, and a single lock would make the
// slowest writer everyone's latency. Two writers on the SAME conversation must contend, because the
// record is republished whole and a read-modify-write that interleaves loses one of them.
//
// This bounds in-process writers only. It is not a claim about other processes — that is what the
// on-disk fence in conversation-store.ts is for, and the two are different guarantees.

type Chain = Promise<unknown>

export class ConversationAppendQueue {
  private readonly chains = new Map<string, Chain>()

  /** Runs `work` after every earlier call for the same key has settled. */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    // Why the same handler on both branches: an earlier append that REJECTED must not cancel the
    // queue behind it. The next writer is a separate operation and is still entitled to run.
    const result = previous.then(work, work)
    const settled: Chain = result.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(key, settled)
    void settled.then(() => {
      // Prune only when nothing queued behind this one, so the map does not grow with every
      // conversation the process has ever written.
      if (this.chains.get(key) === settled) {
        this.chains.delete(key)
      }
    })
    return result
  }

  /** Conversations with work queued right now. Exposed for tests and diagnostics. */
  get pendingKeys(): string[] {
    return [...this.chains.keys()]
  }
}
