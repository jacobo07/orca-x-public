import { describe, expect, it, vi } from 'vitest'
import type { GhAuthDiagnostic } from '../../../../shared/github/auth-types'

// Why a marker instead of the plain fallback: with `(_key, fallback) => fallback` a raw template
// literal and a translated string look identical, which is how the summaries shipped untranslated
// while every button label around them was localized. The marker makes bypassing translate visible.
const MARK = '[t]'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, vars?: Record<string, unknown>) =>
    `${MARK}${
      vars
        ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(vars[name] ?? ''))
        : fallback
    }`
}))

import { buildRemediation } from './gh-auth-remediation'

function diagnostic(overrides: Partial<GhAuthDiagnostic> = {}): GhAuthDiagnostic {
  return {
    ghAvailable: true,
    activeAccount: {
      host: 'github.com',
      user: 'alice',
      active: true,
      envToken: null,
      source: 'keyring',
      scopes: ['project', 'read:org', 'repo']
    },
    accounts: [],
    envTokenInProcess: null,
    missingScopes: [],
    requiredScopes: ['project', 'read:org', 'repo'],
    hasKeyringFallback: false,
    requiredHost: null,
    requiredHostAuthenticated: true,
    ...overrides
  }
}

const envShadowDiagnostic = (hasKeyringFallback: boolean): GhAuthDiagnostic =>
  diagnostic({
    hasKeyringFallback,
    activeAccount: {
      host: 'github.com',
      user: 'alice',
      active: true,
      envToken: 'GITHUB_TOKEN',
      source: 'env',
      scopes: []
    }
  })

describe('gh auth remediation prose is localized', () => {
  // Each case is a branch of buildRemediation that authors its own prose. The two branches that
  // surface `errorMessage` verbatim are excluded on purpose: that text comes from gh, not from us.
  const cases: { name: string; diag: GhAuthDiagnostic; kind: 'auth_required' | 'scope_missing' }[] =
    [
      {
        name: 'GHES host with no login',
        diag: diagnostic({ requiredHost: 'ghe.acme.test', requiredHostAuthenticated: false }),
        kind: 'scope_missing'
      },
      { name: 'gh not installed', diag: diagnostic({ ghAvailable: false }), kind: 'auth_required' },
      { name: 'env token shadows keyring', diag: envShadowDiagnostic(true), kind: 'scope_missing' },
      {
        name: 'env token with no keyring fallback',
        diag: envShadowDiagnostic(false),
        kind: 'scope_missing'
      },
      {
        name: 'inherited env token',
        diag: diagnostic({
          envTokenInProcess: 'GITHUB_TOKEN',
          activeAccount: null
        }),
        kind: 'scope_missing'
      },
      { name: 'not signed in', diag: diagnostic({ activeAccount: null }), kind: 'auth_required' },
      {
        name: 'one missing scope',
        diag: diagnostic({ missingScopes: ['project'] }),
        kind: 'scope_missing'
      },
      {
        name: 'several missing scopes',
        diag: diagnostic({ missingScopes: ['project', 'read:org'] }),
        kind: 'scope_missing'
      }
    ]

  for (const testCase of cases) {
    it(`translates the summary and detail for: ${testCase.name}`, () => {
      const remedy = buildRemediation('gh said no.', testCase.kind, testCase.diag)

      expect(remedy.summary.startsWith(MARK), `summary bypassed translate: ${remedy.summary}`).toBe(
        true
      )
      if (remedy.detail !== undefined) {
        expect(remedy.detail.startsWith(MARK), `detail bypassed translate: ${remedy.detail}`).toBe(
          true
        )
      }
    })
  }

  it('interpolates the variable name rather than leaking the raw marker', () => {
    const remedy = buildRemediation('gh said no.', 'scope_missing', envShadowDiagnostic(true))

    expect(remedy.summary).toContain('GITHUB_TOKEN')
    // An uninterpolated `{{var}}` reaching the UI is what translating without passing vars looks like.
    expect(remedy.summary).not.toContain('{{')
    expect(remedy.detail).not.toContain('{{')
  })

  it('keeps gh’s own error message verbatim when it has no diagnosis to add', () => {
    // Translating a server-provided string would replace real detail with a generic sentence.
    expect(buildRemediation('gh said no.', 'auth_required', null).summary).toBe('gh said no.')
  })
})
