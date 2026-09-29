// Per-record serialization for the durable backlog writer. Bounds in-process writers only; the
// on-disk revision fence is the separate cross-process guarantee.

type Chain = Promise<unknown>

export class BacklogRecordQueue {
  private readonly chains = new Map<string, Chain>()

  /** Runs `work` after every earlier call for the same key has settled. */
  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    // Why the same handler on both branches: a rejected predecessor must not cancel its successors.
    const result = previous.then(work, work)
    const settled: Chain = result.then(
      () => undefined,
      () => undefined
    )
    this.chains.set(key, settled)
    void settled.then(() => {
      // Prune only when nothing queued behind, so the map does not grow with every record written.
      if (this.chains.get(key) === settled) {
        this.chains.delete(key)
      }
    })
    return result
  }

  get pendingKeys(): string[] {
    return [...this.chains.keys()]
  }
}
