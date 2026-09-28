import type { DeskProjection } from './desk-continuity-projection'

/** What the continuity read answers. A client with no desktop store says so; it never answers an empty desk. */
export type DeskReadResult =
  | { status: 'loaded'; projection: DeskProjection; readAt: number }
  | { status: 'unavailable' }
