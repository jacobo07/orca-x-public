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
  tabId?: string
}

type Entry = {
  operationId: string
  ownerId: number
  acquiredAt: number
  tabId?: string
  boundAt?: number
}

/** A user's Continue past a collision, carried from the dialog to the spawn it allows. */
type Permit = {
  key: string
  ownerId: number
  grantedAt: number
  tabId?: string
}

export type MaterializationReservationDeps = {
  now: () => number
  /** Whether a PTY is currently bound to any pane of the tab. */
  hasBoundPty: (tabId: string) => boolean
}

export class LiveSessionMaterializationReservations {
  private readonly entries = new Map<string, Entry>()
  private readonly permits = new Map<string, Permit>()

  constructor(private readonly deps: MaterializationReservationDeps) {}

  get size(): number {
    return this.entries.size
  }

  get permitCount(): number {
    return this.permits.size
  }

  holder(key: string): MaterializationHolder | null {
    const entry = this.current(key)
    if (!entry) {
      return null
    }
    return {
      operationId: entry.operationId,
      ownerId: entry.ownerId,
      phase: entry.boundAt === undefined ? 'reserved' : 'bound',
      ...(entry.tabId !== undefined ? { tabId: entry.tabId } : {})
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

  /** Records an accepted collision for one operation; the spawn it names may consume it once. */
  grantPermit(key: string, operationId: string, ownerId: number): boolean {
    this.sweepPermits()
    if (!this.permits.has(operationId) && this.permits.size >= MAX_MATERIALIZATION_RESERVATIONS) {
      return false
    }
    this.permits.set(operationId, { key, ownerId, grantedAt: this.deps.now() })
    return true
  }

  /** True once for the tab an accepted operation attached to; never for an automatic spawn. */
  consumePermit(key: string, tabId: string): boolean {
    this.sweepPermits()
    for (const [operationId, permit] of this.permits) {
      if (permit.key === key && permit.tabId === tabId) {
        this.permits.delete(operationId)
        return true
      }
    }
    return false
  }

  /** Names the tab the operation materialized into. Only the owner may attach. */
  attachTab(operationId: string, ownerId: number, tabId: string): boolean {
    let attached = false
    const permit = this.permits.get(operationId)
    if (permit && permit.ownerId === ownerId) {
      permit.tabId = tabId
      attached = true
    }
    for (const entry of this.entries.values()) {
      if (entry.operationId === operationId && entry.ownerId === ownerId) {
        entry.tabId = tabId
        attached = true
      }
    }
    return attached
  }

  /** Only the operation that acquired a reservation can give it back. */
  release(operationId: string, ownerId: number): void {
    if (this.permits.get(operationId)?.ownerId === ownerId) {
      this.permits.delete(operationId)
    }
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
    for (const [operationId, permit] of this.permits) {
      if (permit.ownerId === ownerId) {
        this.permits.delete(operationId)
      }
    }
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

  // Why: a Continue answers the collision the user saw; after the unbound ceiling it is stale.
  private sweepPermits(): void {
    const now = this.deps.now()
    for (const [operationId, permit] of this.permits) {
      if (now - permit.grantedAt > MATERIALIZATION_UNBOUND_CEILING_MS) {
        this.permits.delete(operationId)
      }
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
