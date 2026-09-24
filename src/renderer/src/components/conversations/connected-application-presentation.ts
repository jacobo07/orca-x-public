import { translate } from '@/i18n/i18n'

import type { ConnectedApplicationStatusLookup } from './use-connected-applications'

export type AppTone = 'ready' | 'caution' | 'refused' | 'neutral'

export type AppStatusPresentation = {
  state: string
  label: string
  detail: string | null
  tone: AppTone
}

/** Reachable is not connected: only an accepted session earns the positive tone. */
export function presentConnectedApplicationStatus(
  lookup: ConnectedApplicationStatusLookup | undefined
): AppStatusPresentation {
  if (!lookup || lookup.status === 'checking') {
    return {
      state: 'checking',
      label: translate('workspace.app.checking', 'Checking…'),
      detail: null,
      tone: 'neutral'
    }
  }
  if (lookup.status === 'failed') {
    return {
      state: 'check-failed',
      label: translate('workspace.app.checkFailed', 'Could not check'),
      detail: lookup.reason,
      tone: 'caution'
    }
  }
  const observed = lookup.observed
  const build = 'build' in observed && observed.build ? `build ${observed.build}` : null
  switch (observed.state) {
    case 'connected':
      return {
        state: observed.state,
        label: translate('workspace.app.connected', 'Connected'),
        detail: build,
        tone: 'ready'
      }
    case 'auth-required':
      return {
        state: observed.state,
        label: translate('workspace.app.authRequired', 'Sign-in required'),
        detail: build,
        tone: 'caution'
      }
    case 'degraded':
      return {
        state: observed.state,
        label: translate('workspace.app.degraded', 'Degraded'),
        detail: observed.detail,
        tone: 'caution'
      }
    case 'unreachable':
      return {
        state: observed.state,
        label: translate('workspace.app.unreachable', 'Unreachable'),
        detail: observed.detail,
        tone: 'refused'
      }
    case 'unknown':
      return {
        state: observed.state,
        label: translate('workspace.app.unknown', 'Session state unknown'),
        detail: observed.detail,
        tone: 'neutral'
      }
  }
}
