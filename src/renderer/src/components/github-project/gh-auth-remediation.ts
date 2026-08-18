/**
 * Turns a gh auth failure plus a live diagnostic into the remediation to show.
 *
 * Why this is not inline prose: every string here is user-facing, so it goes through translate().
 * The button labels always did; the summaries and details did not, which rendered an English block
 * inside an otherwise localized UI.
 */
import type { GhAuthDiagnostic } from '../../../../shared/github/auth-types'
import { translate } from '@/i18n/i18n'

export type AuthErrorKind = 'auth_required' | 'scope_missing'

const REFRESH_CMD = 'gh auth refresh -s project -s read:org -s repo'
const LOGIN_CMD = 'gh auth login'

// Why: GHES credentials are per-host — a bare `gh auth login` signs into
// github.com and leaves the Enterprise host exactly as broken as before.
function loginCommandForHost(host: string | null | undefined): string {
  return host && host.toLowerCase() !== 'github.com'
    ? `gh auth login --hostname ${host}`
    : LOGIN_CMD
}

function refreshCommandForHost(host: string | null | undefined): string {
  return host && host.toLowerCase() !== 'github.com'
    ? `gh auth refresh --hostname ${host} -s project -s read:org -s repo`
    : REFRESH_CMD
}

// AGENTS.md requires platform-specific shell guidance. The env-shadow
// remediation needs different commands per host shell — bash/zsh on
// macOS/Linux vs PowerShell on Windows.
const IS_WINDOWS = typeof navigator !== 'undefined' && /Win(dows|32|64)/i.test(navigator.userAgent)

function findEnvVarCommand(varName: string): { label: string; command: string } {
  if (IS_WINDOWS) {
    return {
      label: translate(
        'auto.components.github.project.GhAuthErrorHelp.df636f5886',
        'Check if it’s set (PowerShell)'
      ),
      command: `Get-ChildItem Env:${varName}`
    }
  }
  return {
    label: translate(
      'auto.components.github.project.GhAuthErrorHelp.ae43542893',
      'Find where it’s set'
    ),
    command: `grep -RIn '${varName}' ~/.zshrc ~/.zshenv ~/.bashrc ~/.bash_profile ~/.profile ~/.config 2>/dev/null`
  }
}

function unsetEnvVarCommand(varName: string): { label: string; command: string } {
  if (IS_WINDOWS) {
    // Persistent removal at the user scope; the user still needs a fresh
    // shell/Orca relaunch for the change to take effect.
    return {
      label: translate(
        'auto.components.github.project.GhAuthErrorHelp.fd17b3019f',
        'Unset (PowerShell, persistent)'
      ),
      command: `Remove-Item Env:${varName}; [Environment]::SetEnvironmentVariable('${varName}', $null, 'User')`
    }
  }
  return {
    label: translate(
      'auto.components.github.project.GhAuthErrorHelp.891a7d4616',
      'Unset for this shell'
    ),
    command: `unset ${varName}`
  }
}

export type Remediation = {
  /** Short human-readable summary of why the error is happening. */
  summary: string
  /** Optional follow-up paragraph explaining the fix. */
  detail?: string
  /** Commands to surface as copyable buttons, in order. */
  commands: { label: string; command: string }[]
  /** Optional external doc link. */
  docsUrl?: string
}

const ENV_DOCS_URL = 'https://cli.github.com/manual/gh_help_environment'

/** Trailing sentence of the env-shadow detail: what happens once the variable is gone. */
function envShadowFollowUp(hasKeyringFallback: boolean): string {
  return hasKeyringFallback
    ? translate(
        'auto.components.github.project.ghAuthRemediation.envShadowKeyringTakesOver',
        ' Your keyring already has a `gh` login that will take over once the env var is gone.'
      )
    : translate(
        'auto.components.github.project.ghAuthRemediation.envShadowSignInAfter',
        ' After unsetting it, run `gh auth login` to sign in normally, then retry.'
      )
}

export function buildRemediation(
  errorMessage: string,
  kind: AuthErrorKind,
  diag: GhAuthDiagnostic | null,
  requestedHost?: string
): Remediation {
  // Diagnostic still loading or unavailable — fall back to the canned advice
  // so the UI never gets worse than the pre-diagnosis behavior.
  if (!diag) {
    return {
      summary: errorMessage,
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.b436c586d1',
            'Copy command'
          ),
          command:
            kind === 'auth_required'
              ? loginCommandForHost(requestedHost)
              : refreshCommandForHost(requestedHost)
        }
      ]
    }
  }

  // Why: an Enterprise host with no gh account at all outranks every other
  // diagnosis — env-token or scope advice for github.com would be misleading.
  if (diag.requiredHost && diag.requiredHostAuthenticated === false) {
    return {
      summary: translate(
        'auto.components.github.project.ghAuthRemediation.ghesNotSignedIn',
        '`gh` is not signed in to {{host}}.',
        { host: diag.requiredHost }
      ),
      detail: translate(
        'auto.components.github.project.ghAuthRemediation.ghesNotSignedInDetail',
        'GitHub Enterprise hosts need their own `gh` login, separate from github.com. Run the login command in a terminal, complete the browser flow on {{host}}, then reload.',
        { host: diag.requiredHost }
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.9c2da6353b',
            'Copy login command'
          ),
          command: loginCommandForHost(diag.requiredHost)
        }
      ]
    }
  }

  if (!diag.ghAvailable) {
    return {
      summary: translate(
        'auto.components.github.project.ghAuthRemediation.ghMissing',
        'GitHub CLI (`gh`) is not installed or not on PATH.'
      ),
      detail: translate(
        'auto.components.github.project.ghAuthRemediation.ghMissingDetail',
        'Orca uses `gh` to talk to GitHub Projects. Install it from cli.github.com, then sign in.'
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.9c2da6353b',
            'Copy login command'
          ),
          command: loginCommandForHost(diag.requiredHost ?? requestedHost)
        }
      ],
      docsUrl: 'https://cli.github.com/'
    }
  }

  const active = diag.activeAccount
  // Most insidious failure mode: gh is using a token from the environment,
  // so `gh auth refresh` prints "GITHUB_TOKEN is being used... first clear
  // the value from the environment" and exits 0 without doing anything.
  if (active?.envToken) {
    const varName = active.envToken
    const followUp = envShadowFollowUp(diag.hasKeyringFallback)
    return {
      summary: translate(
        'auto.components.github.project.ghAuthRemediation.envShadow',
        '`{{varName}}` is set in your environment, so `gh` is using that token instead of your keyring login. `gh auth refresh` cannot modify env-supplied tokens — that’s why running it didn’t help.',
        { varName }
      ),
      detail: IS_WINDOWS
        ? translate(
            'auto.components.github.project.ghAuthRemediation.envShadowDetailWindows',
            'Find where `{{varName}}` is set (System or User environment variables, or your PowerShell profile), remove it, then restart Orca so the new environment is picked up.{{followUp}}',
            { varName, followUp }
          )
        : translate(
            'auto.components.github.project.ghAuthRemediation.envShadowDetailPosix',
            'Find where `{{varName}}` is exported (commonly `~/.zshrc`, `~/.zshenv`, `~/.bashrc`, `~/.profile`, or your shell’s secrets manager), remove it, then restart Orca so the new environment is picked up.{{followUp}}',
            { varName, followUp }
          ),
      commands: [findEnvVarCommand(varName), unsetEnvVarCommand(varName)],
      docsUrl: ENV_DOCS_URL
    }
  }

  // gh is not the problem, but the Electron process inherited GITHUB_TOKEN
  // from the parent shell. Even after the user runs `gh auth refresh` in a
  // separate terminal, Orca's gh subprocess sees the env var and uses it.
  if (diag.envTokenInProcess && (!active || diag.missingScopes.length > 0)) {
    const varName = diag.envTokenInProcess
    return {
      summary: translate(
        'auto.components.github.project.ghAuthRemediation.inheritedEnvToken',
        'Orca inherited `{{varName}}` from your shell, and `gh` is using that token. `gh auth refresh` doesn’t apply to env-supplied tokens.',
        { varName }
      ),
      detail: IS_WINDOWS
        ? translate(
            'auto.components.github.project.ghAuthRemediation.inheritedEnvTokenDetailWindows',
            'Unset `{{varName}}` in the shell that launches Orca (or in your user environment variables), then restart Orca.',
            { varName }
          )
        : translate(
            'auto.components.github.project.ghAuthRemediation.inheritedEnvTokenDetailPosix',
            'Unset `{{varName}}` in the shell that launches Orca (or in your shell rc file), then restart Orca.',
            { varName }
          ),
      commands: [findEnvVarCommand(varName), unsetEnvVarCommand(varName)],
      docsUrl: ENV_DOCS_URL
    }
  }

  if (kind === 'auth_required' || !active) {
    return {
      summary: translate(
        'auto.components.github.project.ghAuthRemediation.notSignedIn',
        'You’re not signed in to GitHub via `gh`.'
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.9c2da6353b',
            'Copy login command'
          ),
          command: loginCommandForHost(diag.requiredHost)
        }
      ]
    }
  }

  // Plain missing-scope case on a keyring login — refresh will work.
  if (diag.missingScopes.length > 0) {
    const scopes = diag.missingScopes.map((scope) => `\`${scope}\``).join(', ')
    return {
      // Why two keys rather than one with a count: languages pluralize the noun and its article
      // differently, and a single string with a bolted-on "(s)" reads as untranslated in all of them.
      summary:
        diag.missingScopes.length === 1
          ? translate(
              'auto.components.github.project.ghAuthRemediation.missingScope',
              'Your `gh` token is missing the {{scopes}} scope needed for GitHub Projects.',
              { scopes }
            )
          : translate(
              'auto.components.github.project.ghAuthRemediation.missingScopes',
              'Your `gh` token is missing the {{scopes}} scopes needed for GitHub Projects.',
              { scopes }
            ),
      detail: translate(
        'auto.components.github.project.ghAuthRemediation.missingScopeDetail',
        'Run the refresh command in a terminal. It will open a browser to authorize the new scopes, then come back here and reload.'
      ),
      commands: [
        {
          label: translate(
            'auto.components.github.project.GhAuthErrorHelp.3fefeebde4',
            'Copy refresh command'
          ),
          command: refreshCommandForHost(diag.requiredHost)
        }
      ]
    }
  }

  // Scopes look fine but GitHub still rejected us — likely SAML SSO not
  // authorized for this org's token, or the project is in an org the token
  // can't see. Surface the most likely fix.
  return {
    summary: errorMessage,
    detail: translate(
      'auto.components.github.project.ghAuthRemediation.samlDetail',
      'Your token has the required scopes but GitHub still denied access. If the project is in an org with SAML SSO, you must authorize this token for the org under Settings → Developer settings → Personal access tokens → Configure SSO.'
    ),
    commands: [
      {
        label: translate(
          'auto.components.github.project.GhAuthErrorHelp.3fefeebde4',
          'Copy refresh command'
        ),
        command: refreshCommandForHost(diag.requiredHost ?? requestedHost)
      }
    ],
    docsUrl:
      'https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on'
  }
}
