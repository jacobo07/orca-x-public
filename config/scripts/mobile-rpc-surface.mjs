// Which allowlisted RPC methods mobile production source ever names.
//
// Why: the allowlist is REACH (mobile may call it), not SURFACE (something on mobile does). A
// method the host exposes to mobile that no mobile source names has no screen by construction —
// `terminal.read` sat in exactly that state, backend present and allowlisted, with no consumer.
//
// The claim is one-directional on purpose. A method name appearing as a string literal is evidence
// of a REFERENCE (sendRequest, subscribe, transport-internal replay, a union-typed parameter, a relay
// wrapper), not proof of a reachable screen. So "unreferenced" is a sound accusation and
// "referenced" is only an upper bound — the same stance the aperture audit takes on reach.
// Measured 2026-09-18: mobile builds no method name dynamically, so a literal sweep is complete.

import fs from 'node:fs'
import path from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])
const LITERAL_PATTERN = /(['"`])([a-zA-Z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)\1/g

// A sweep that silently matched nothing must not report every method as unsurfaced.
export const REFERENCED_FLOOR = 150

export function collectMobileProductionSources(roots) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (
        SOURCE_EXTENSIONS.has(path.extname(entry.name)) &&
        !/\.test\.|\.spec\./.test(entry.name)
      ) {
        out.push(full)
      }
    }
  }
  for (const root of roots) {
    if (fs.existsSync(root)) {
      walk(root)
    }
  }
  return out
}

/** Comments name methods in prose; only code may count as a reference. */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

export function referencedMethodNames(sourceTexts, candidates) {
  const wanted = new Set(candidates)
  const found = new Set()
  for (const text of sourceTexts) {
    for (const m of stripComments(text).matchAll(LITERAL_PATTERN)) {
      if (wanted.has(m[2])) {
        found.add(m[2])
      }
    }
  }
  return found
}

/**
 * Pure verdict over the allowlist and the referenced set, ratcheted by a shrink-only baseline in
 * both directions: a newly unreferenced method fails as new debt, and a baselined method that is
 * now referenced (or no longer allowlisted) fails as a stale exception.
 */
export function evaluateSurface({
  allowlist,
  referenced,
  baseline,
  referencedFloor = REFERENCED_FLOOR
}) {
  const allow = new Set(allowlist)
  const ref = new Set([...referenced].filter((m) => allow.has(m)))
  const base = new Set(baseline)
  const unreferenced = [...allow].filter((m) => !ref.has(m)).sort()
  const newlyUnreferenced = unreferenced.filter((m) => !base.has(m))
  const stale = [...base].filter((m) => !unreferenced.includes(m)).sort()
  const failures = []
  if (ref.size < referencedFloor) {
    failures.push({
      kind: 'surface-floor',
      message: `mobile source names ${ref.size} allowlisted methods, expected at least ${referencedFloor}. The sweep probably stopped matching.`
    })
  }
  if (newlyUnreferenced.length > 0) {
    failures.push({
      kind: 'new-unsurfaced',
      message:
        `${newlyUnreferenced.length} allowlisted method(s) are named nowhere in mobile production source.\n` +
        `    Reach without a surface is not parity: wire a mobile consumer, or baseline it deliberately.\n` +
        `    ${newlyUnreferenced.join('\n    ')}`
    })
  }
  if (stale.length > 0) {
    failures.push({
      kind: 'stale-surface-baseline',
      message: `${stale.length} baseline entr(ies) are now referenced or no longer allowlisted; remove them:\n    ${stale.join('\n    ')}`
    })
  }
  return { failures, referenced: [...ref].sort(), unreferenced, newlyUnreferenced, stale }
}
