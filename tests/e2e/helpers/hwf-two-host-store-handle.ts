import type { AppStore } from './runtime-types'

// Why: runtime-types.ts types window.__store as getState-only, but it is the zustand store; these specs also call setState and subscribe.
export type SubscribableAppStore = AppStore & {
  setState(partial: Record<string, unknown>): void
  subscribe(listener: () => void): () => void
}
