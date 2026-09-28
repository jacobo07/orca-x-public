import { describe, expect, it } from 'vitest'
import { checkClaudeAuth } from './claude-auth-readiness'

const NOW = 1_800_000_000_000
const signedIn = JSON.stringify({
  claudeAiOauth: { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: NOW + 86_400_000 }
})

function onLinux(file: string | NodeJS.ErrnoException, env: Record<string, string> = {}) {
  return checkClaudeAuth({
    platform: 'linux',
    env,
    now: () => NOW,
    readCredentialsFile: () => {
      if (typeof file !== 'string') {
        throw file
      }
      return file
    }
  })
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('checkClaudeAuth', () => {
  it('is ready with a stored sign-in', async () => {
    expect(await onLinux(signedIn)).toEqual({ ready: true })
  })

  it('tells a missing credential apart from an unreadable one', async () => {
    expect(await onLinux(errno('ENOENT'))).toEqual({ ready: false, detail: 'claude credential is absent' })
    expect(await onLinux(errno('EACCES'))).toEqual({ ready: false, detail: 'claude credential is unreadable' })
    expect(await onLinux('{half a rewrite')).toEqual({ ready: false, detail: 'claude credential is unreadable' })
  })

  it('refuses a credential with no token, or a sign-in whose refresh token has expired', async () => {
    expect(await onLinux('{"claudeAiOauth":{}}')).toEqual({ ready: false, detail: 'claude credential holds no token' })
    const expired = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', refreshTokenExpiresAt: NOW - 1 } })
    expect(await onLinux(expired)).toEqual({ ready: false, detail: 'claude sign-in has expired' })
  })

  it('accepts an API key in the environment without reading any file', async () => {
    expect(await onLinux(errno('ENOENT'), { ANTHROPIC_API_KEY: 'k' })).toEqual({ ready: true })
  })

  it('reads the keychain on macOS instead of a file', async () => {
    const result = await checkClaudeAuth({
      platform: 'darwin',
      env: {},
      now: () => NOW,
      readKeychain: async () => signedIn,
      readCredentialsFile: () => {
        throw new Error('must not read a file on macOS')
      }
    })
    expect(result).toEqual({ ready: true })
  })

  it('never puts a token into what it reports', async () => {
    const result = await onLinux(JSON.stringify({ claudeAiOauth: { accessToken: 'SECRET-TOKEN' } }))
    expect(JSON.stringify(result)).not.toContain('SECRET-TOKEN')
  })
})
