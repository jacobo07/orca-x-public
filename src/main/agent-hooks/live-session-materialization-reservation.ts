/** Provisional right to materialize one provider session, held from the collision check
 *  until the new runtime is observably live. It is never live truth: presence stays the
 *  authority for that. In memory only, keyed by the canonical claim key, owned per
 *  operation, and sized by in-flight attempts rather than by session history. */

export const MATERIALIZATION_UNBOUND_CEILING_MS = 30_000
export const MATERIALIZATION_BOUND_CEILING_MS = 120_000
export const MAX_MATERIALIZATION_RESERVATIONS = 256

export type MaterializationAcquireResult = 'granted' | 'held-by-self' | 'contended' | 'capacity'

export type MaterializationHolder = {
  operationId: string
  ownerId: number
  phase: 'reserved' | 'bound'
}

type Entry = {
  operationId: string
  ownerId: number
  acquiredAt: number
  tabId?: string
  boundAt?: number
}

export type MaterializationReservationDeps = {
  now: () => number
  /** Whether a PTY is currently bound to any pane of the tab. */
  hasBoundPty: (tabId: string) => boolean
}

export class LiveSessionMaterializationReservations {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: MaterializationReservationDeps) {}

  get size(): number {
    return this.entries.size
  }

  holder(key: string): MaterializationHolder | null {
    const entry = this.current(key)
    if (!entry) {
      return null
    }
    return {
      operationId: entry.operationId,
      ownerId: entry.ownerId,
      phase: entry.boundAt === undefined ? 'reserved' : 'bound'
    }
  }

  /** Synchronous check-and-set: nothing may be awaited between the read and the write. */
  tryAcquire(key: string, operationId: string, ownerId: number): MaterializationAcquireResult {
    const entry = this.current(key)
    if (entry) {
      return entry.operationId === operationId && entry.ownerId === ownerId
        ? 'held-by-self'
        : 'contended'
    }
    if (this.entries.size >= MAX_MATERIALIZATION_RESERVATIONS) {
      this.sweep()
      if (this.entries.size >= MAX_MATERIALIZATION_RESERVATIONS) {
        return 'capacity'
      }
    }
    this.entries.set(key, { operationId, ownerId, acquiredAt: this.deps.now() })
    return 'granted'
  }

  /** Names the tab the operation materialized into. Only the owner may attach. */
  attachTab(operationId: string, ownerId: number, tabId: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.operationId === operationId && entry.ownerId === ownerId) {
        entry.tabId = tabId
        return true
      }
    }
    return false
  }

  /** Only the operation that acquired a reservation can give it back. */
  release(operationId: string, ownerId: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.operationId === operationId && entry.ownerId === ownerId) {
        this.entries.delete(key)
      }
    }
  }

  /** Live handoff or PTY teardown for the tab the reservation materialized into. */
  releaseForTab(tabId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.tabId === tabId) {
        this.entries.delete(key)
      }
    }
  }

  releaseForOwner(ownerId: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.ownerId === ownerId) {
        this.entries.delete(key)
      }
    }
  }

  private sweep(): void {
    for (const key of this.entries.keys()) {
      this.current(key)
    }
  }

  // Why: expiry is evaluated on read so no timer exists; the ceilings only reap leaks
  // (a tab that never spawned, a runtime that never reported), never decide success.
  private current(key: string): Entry | null {
    const entry = this.entries.get(key)
    if (!entry) {
      return null
    }
    const now = this.deps.now()
    const bound = entry.tabId !== undefined && this.deps.hasBoundPty(entry.tabId)
    if (bound) {
      entry.boundAt ??= now
      if (now - entry.boundAt <= MATERIALIZATION_BOUND_CEILING_MS) {
        return entry
      }
    } else if (entry.boundAt === undefined) {
      if (now - entry.acquiredAt <= MATERIALIZATION_UNBOUND_CEILING_MS) {
        return entry
      }
    }
    // Why: a runtime that was bound and is gone ended without handing off; nothing holds it.
    this.entries.delete(key)
    return null
  }
}
