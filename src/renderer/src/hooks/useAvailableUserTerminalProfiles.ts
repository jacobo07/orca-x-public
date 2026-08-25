import { useEffect, useMemo, useRef, useState } from 'react'
import type { UserTerminalLaunchProfile } from '../../../shared/terminal-launch-profile-definition'
import { reviewUserTerminalLaunchProfiles } from '../../../shared/terminal-launch-profile-definition'
import { useAppStore } from '../store'

/**
 * Answers which declared profiles this machine can actually launch.
 *
 * A profile that names a wrapper is only a profile while the wrapper is there; offering it after
 * the file is gone turns a menu entry into a promise the product cannot keep. So a declaration
 * carrying `requiresPath` is withheld until the path is proven to exist, and proven again when the
 * connection or the declaration changes -- never assumed from the last answer for a different host.
 */

type ProbeState = Map<string, boolean>

export function useAvailableUserTerminalProfiles(connectionId?: string | null): {
  profiles: readonly UserTerminalLaunchProfile[]
  /** Declared entries that could not be read; surfaced so a typo is not silence. */
  invalidCount: number
  /** Declared entries withheld because their prerequisite is absent on this host. */
  unavailable: readonly UserTerminalLaunchProfile[]
} {
  const declared = useAppStore((s) => s.settings?.terminalLaunchProfiles)
  const review = useMemo(() => reviewUserTerminalLaunchProfiles(declared), [declared])
  const [probes, setProbes] = useState<ProbeState>(() => new Map())
  // Why keyed by host: the same path can exist locally and not on the remote the worktree runs on.
  const probeScope = connectionId?.trim() || 'local'
  const probeScopeRef = useRef(probeScope)

  const required = useMemo(
    () => review.valid.filter((profile) => profile.requiresPath).map((p) => p.requiresPath ?? ''),
    [review.valid]
  )
  const requiredKey = required.join('\u0000')

  useEffect(() => {
    let cancelled = false
    if (probeScopeRef.current !== probeScope) {
      probeScopeRef.current = probeScope
      setProbes(new Map())
    }
    if (required.length === 0) {
      return
    }
    void Promise.all(
      required.map(async (filePath) => {
        const exists = await window.api.fs
          .pathExists({ filePath, ...(connectionId ? { connectionId } : {}) })
          .catch(() => false)
        return [filePath, exists] as const
      })
    ).then((results) => {
      if (cancelled) {
        return
      }
      setProbes(new Map(results))
    })
    return () => {
      cancelled = true
    }
  }, [connectionId, probeScope, required, requiredKey])

  return useMemo(() => {
    const available: UserTerminalLaunchProfile[] = []
    const unavailable: UserTerminalLaunchProfile[] = []
    for (const profile of review.valid) {
      if (!profile.requiresPath) {
        available.push(profile)
        continue
      }
      // Why withheld while unknown: an unfinished probe is not evidence the file is there, and the
      // menu must not offer a launch on the strength of a pending answer.
      ;(probes.get(profile.requiresPath) === true ? available : unavailable).push(profile)
    }
    return { profiles: available, invalidCount: review.invalid.length, unavailable }
  }, [probes, review.invalid.length, review.valid])
}
