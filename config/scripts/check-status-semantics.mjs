#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { stripJsonc } from './check-visual-assets.mjs'

// Three verdicts. A gate that could not read main.css and a gate that judged it and found a
// broken token both exit non-zero, and only the second is about the tokens.
export const EXIT_OK = 0
export const EXIT_INVALID = 1
export const EXIT_GATE_FAILED = 2

// --- colour maths -----------------------------------------------------------------------
// WCAG 2.1 relative luminance. Deterministic and dependency-free so the accessibility claim in
// the style guide is recomputed from the live token values on every lint, not asserted once.

export function hexToRgb(hex) {
  const raw = String(hex).trim().replace('#', '')
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw)) {
    return null
  }
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16)
  ]
}

export function relativeLuminance(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) {
    return null
  }
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la === null || lb === null) {
    return null
  }
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function rgbDistance(a, b) {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  if (!ra || !rb) {
    return null
  }
  return Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2])
}

// --- main.css ---------------------------------------------------------------------------

// Take the block a top-level selector opens, up to the closing brace in column 0. Returning
// null rather than an empty map matters: "the block is missing" is a gate failure and "the
// block is empty" would be read as every token being absent.
export function extractBlock(css, selector) {
  const lines = css.split(/\r?\n/)
  const open = lines.findIndex((line) => line.trimEnd() === `${selector} {`)
  if (open === -1) {
    return null
  }
  const close = lines.findIndex((line, i) => i > open && line === '}')
  if (close === -1) {
    return null
  }
  return lines.slice(open + 1, close).join('\n')
}

export function parseDeclarations(block) {
  const out = new Map()
  const re = /^\s*--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/gm
  let match
  while ((match = re.exec(block)) !== null) {
    out.set(match[1], match[2].trim())
  }
  return out
}

// A token that resolves to a literal hex can be held to the contrast floor. One that forwards
// to a Tailwind palette variable is defined outside this file and cannot be, so the gate says
// "unmeasured" instead of quietly passing it.
export function resolveLiteral(declarations, token, depth = 0) {
  if (depth > 8) {
    return null
  }
  const value = declarations.get(token)
  if (value === undefined) {
    return { found: false }
  }
  if (hexToRgb(value)) {
    return { found: true, literal: value }
  }
  const indirect = /^var\(\s*--([a-zA-Z0-9-]+)\s*\)$/.exec(value)
  if (indirect) {
    const next = resolveLiteral(declarations, indirect[1], depth + 1)
    // Forwarding to something this file does not define is the indirect case, not an absence.
    if (next.found === false) {
      return { found: true, literal: null, forwardsTo: indirect[1] }
    }
    return next
  }
  return { found: true, literal: null }
}

export function parseManifest(text) {
  const manifest = JSON.parse(stripJsonc(text))
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion: ${String(manifest.schemaVersion)}`)
  }
  if (!manifest.policy || typeof manifest.policy !== 'object') {
    throw new Error('Manifest has no policy block')
  }
  if (!Array.isArray(manifest.states)) {
    throw new Error('Manifest has no states array')
  }
  if (!manifest.channels || typeof manifest.channels !== 'object') {
    throw new Error('Manifest has no channels block')
  }
  return manifest
}

// --- the checks -------------------------------------------------------------------------

export function checkStates({ manifest, themes, themeExposed, debt = new Map() }) {
  const { policy, states } = manifest
  const problems = []
  const knownDebt = []
  const debtUsed = new Set()
  let measuredComparisons = 0

  for (const entry of states) {
    const id = entry.state ?? '<unnamed state>'
    const token = entry.token
    if (!token) {
      problems.push(`${id}: no token declared`)
      continue
    }

    // A semantic token the product cannot reach from Tailwind is a documented capability with
    // no invocation: it reads as present in main.css and resolves to nothing in a class name.
    if (!themeExposed.has(token)) {
      problems.push(
        `${id}: --${token} is not exposed in the "@theme inline" block, so no Tailwind utility resolves it`
      )
    }

    for (const theme of policy.themes) {
      const declarations = themes[theme]
      const resolved = resolveLiteral(declarations, token)
      if (!resolved.found) {
        problems.push(`${id}: --${token} is not declared in the ${theme} theme`)
        continue
      }

      const isLiteral = resolved.literal !== null
      // Both directions fail. Literal -> indirect silently blinds the contrast check while
      // every other assertion stays green; indirect -> literal means this entry is stale and
      // the token can now be held to the floor.
      if (entry.contrast === 'measured' && !isLiteral) {
        problems.push(
          `${id}: declared contrast "measured" but --${token} resolves to ${resolved.forwardsTo ? `var(--${resolved.forwardsTo})` : 'a non-literal value'} in the ${theme} theme — the contrast check cannot see it`
        )
        continue
      }
      if (entry.contrast === 'indirect' && isLiteral) {
        problems.push(
          `${id}: declared contrast "indirect" but --${token} is now the literal ${resolved.literal} in the ${theme} theme — upgrade this entry to "measured"`
        )
        continue
      }
      if (!isLiteral) {
        continue
      }

      const role = entry.contrastRole ?? 'text'
      const floor = policy.contrastFloors[role]
      if (floor === undefined) {
        problems.push(`${id}: contrastRole "${role}" has no floor in policy.contrastFloors`)
        continue
      }

      // A fill is judged against what is painted on it, not against the page behind it.
      // Measuring --sidebar-primary against --background asks whether a button's blue is
      // legible text, which it never was.
      const against =
        role === 'surface'
          ? entry.pairedForeground
            ? [entry.pairedForeground]
            : []
          : policy.surfaceTokens
      if (role === 'surface' && against.length === 0) {
        problems.push(`${id}: contrastRole "surface" requires a pairedForeground token`)
        continue
      }

      for (const otherToken of against) {
        const other = resolveLiteral(declarations, otherToken)
        if (!other.found || other.literal === null) {
          problems.push(
            `${id}: --${otherToken} does not resolve to a literal in the ${theme} theme, so contrast against it cannot be measured`
          )
          continue
        }
        const ratio = contrastRatio(resolved.literal, other.literal)
        measuredComparisons += 1
        if (ratio >= floor) {
          continue
        }
        const key = `${id}|${token}|${theme}|${otherToken}`
        const reason = debt.get(key)
        if (reason !== undefined) {
          debtUsed.add(key)
          knownDebt.push(
            `${key} — ${ratio.toFixed(2)}:1 against floor ${floor}:1 (frozen: ${reason})`
          )
          continue
        }
        problems.push(
          `${id}: --${token} (${resolved.literal}) on --${otherToken} (${other.literal}) is ${ratio.toFixed(2)}:1 in the ${theme} theme, below the ${floor}:1 ${role} floor. If this is pre-existing and out of scope, freeze it with a reason in ${policy.debtBaseline} as: ${key}`
        )
      }

      // Legible is not the same as distinguishable. UNKNOWN rendered in the neutral the chrome
      // already spends on disabled and idle passes every contrast check and still tells the
      // reader "nothing here" instead of "we do not know".
      if (entry.separated === true) {
        const against = resolveLiteral(declarations, policy.separationFrom)
        if (!against.found || against.literal === null) {
          problems.push(
            `${id}: --${policy.separationFrom} does not resolve to a literal in the ${theme} theme, so separation cannot be measured`
          )
          continue
        }
        const ratio = contrastRatio(resolved.literal, against.literal)
        const distance = rgbDistance(resolved.literal, against.literal)
        measuredComparisons += 1
        if (
          ratio < policy.minimumSeparationContrast ||
          distance < policy.minimumSeparationRgbDistance
        ) {
          problems.push(
            `${id}: --${token} (${resolved.literal}) is not separable from --${policy.separationFrom} (${against.literal}) in the ${theme} theme — contrast ${ratio.toFixed(2)} (floor ${policy.minimumSeparationContrast}), rgbDistance ${distance.toFixed(0)} (floor ${policy.minimumSeparationRgbDistance}). Rendered this close, "unknown" reads as "disabled".`
          )
        }
      }
    }
  }

  return { problems, measuredComparisons, knownDebt, debtUsed }
}

// One line per frozen offender: STATE|token|theme|surface  # why it is still here.
// A reason is mandatory — an exemption nobody can argue with is an exemption nobody removes.
export function parseDebtBaseline(text) {
  const debt = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const hash = line.indexOf('#')
    if (hash === -1) {
      throw new Error(`debt baseline entry has no reason after "#": ${line}`)
    }
    const key = line.slice(0, hash).trim()
    const reason = line.slice(hash + 1).trim()
    if (key === '' || reason === '') {
      throw new Error(`debt baseline entry is malformed: ${line}`)
    }
    debt.set(key, reason)
  }
  return debt
}

// Selection is not health and health is not a pointer. Two channels sharing one value is the
// defect this manifest exists to prevent, and it is invisible in review because each site looks
// locally reasonable.
export function checkChannelSeparation({ manifest, themes }) {
  const problems = []
  const { channels, policy } = manifest
  const names = Object.keys(channels)

  for (const entry of manifest.states) {
    if (!entry.token || !entry.channel) {
      continue
    }
    const declared = channels[entry.channel]
    if (!declared) {
      problems.push(`${entry.state}: channel "${entry.channel}" is not declared in channels`)
      continue
    }
    if (!declared.includes(entry.token)) {
      problems.push(
        `${entry.state}: token --${entry.token} is used on the "${entry.channel}" channel but is not listed under it`
      )
    }
  }

  for (const theme of policy.themes) {
    const declarations = themes[theme]
    const valueOwners = new Map()
    for (const channel of names) {
      for (const token of channels[channel]) {
        const resolved = resolveLiteral(declarations, token)
        if (!resolved.found || resolved.literal === null) {
          continue
        }
        const key = resolved.literal.toLowerCase()
        const prior = valueOwners.get(key)
        if (prior && prior.channel !== channel) {
          problems.push(
            `--${token} (${channel}) and --${prior.token} (${prior.channel}) are both ${resolved.literal} in the ${theme} theme. Interaction and system state must never share a colour: a selected row would read as a verdict, or a verdict as a selection.`
          )
        }
        if (!prior) {
          valueOwners.set(key, { token, channel })
        }
      }
    }
  }

  return problems
}

// A var() naming something nothing declares is silent by construction: with a fallback the
// literal always wins, so the rule renders, the theme switch does nothing, and no tool
// complains. Found exactly this at main.css's Monaco search highlight, where `--warning` had
// never existed and dark mode had been painting the light theme's amber.
export function findPhantomVariableReferences(
  css,
  { declaredElsewhere = [], declaredPrefixes = [] } = {}
) {
  const declared = new Set(parseDeclarations(css).keys())
  for (const name of declaredElsewhere) {
    declared.add(name)
  }
  const prefixed = (name) => declaredPrefixes.some((prefix) => name.startsWith(prefix))
  const seen = new Map()
  const lines = css.split(/\r?\n/)
  lines.forEach((line, index) => {
    const re = /var\(\s*--([a-zA-Z0-9-]+)/g
    let match
    while ((match = re.exec(line)) !== null) {
      const name = match[1]
      // --color-* is Tailwind's own palette, declared by the framework rather than this file.
      if (declared.has(name) || name.startsWith('color-') || name.startsWith('tw-')) {
        continue
      }
      if (prefixed(name)) {
        continue
      }
      if (!seen.has(name)) {
        seen.set(name, index + 1)
      }
    }
  })
  return [...seen.entries()].map(([name, line]) => ({ name, line }))
}

// A sheet or template that consumes tokens is only token-true while its token names resolve.
// A typo renders as nothing at all -- no error, no colour, and a reference sheet that is
// quietly lying about the system it claims to document.
export async function checkTokenConsumers({ root, css, consumers, readFileImpl = readFile }) {
  const declared = new Set(parseDeclarations(css).keys())
  const problems = []
  let checked = 0
  for (const consumer of consumers) {
    let text
    try {
      text = await readFileImpl(path.join(root, consumer), 'utf8')
    } catch (cause) {
      problems.push(`token consumer ${consumer} could not be read: ${cause.message}`)
      continue
    }
    // Anything the consumer declares itself is fair game; it is only the ones it expects from
    // main.css that have to exist there. Not parseDeclarations here: that is anchored to the
    // start of a line, which is right for main.css and wrong for an inline <style> block or
    // anything minified, where a self-declared token would read as a phantom.
    const own = new Set([...text.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]))
    const seen = new Set()
    for (const match of text.matchAll(/var\(\s*--([a-zA-Z0-9-]+)/g)) {
      const name = match[1]
      if (seen.has(name)) {
        continue
      }
      seen.add(name)
      checked += 1
      if (declared.has(name) || own.has(name) || name.startsWith('color-')) {
        continue
      }
      problems.push(
        `${consumer} uses var(--${name}), which main.css does not declare. It will render as nothing.`
      )
    }
    if (seen.size === 0) {
      problems.push(
        `token consumer ${consumer} references no tokens at all — it is either not token-true or the sweep stopped seeing it`
      )
    }
  }
  return { problems, checked }
}

export async function main({ root, log = console.log, error = console.error } = {}) {
  const manifestPath = path.join(root, 'config', 'status-semantics.jsonc')

  let manifest
  try {
    manifest = parseManifest(await readFile(manifestPath, 'utf8'))
  } catch (cause) {
    error(`Status semantics manifest could not be read or parsed: ${cause.message}`)
    return EXIT_GATE_FAILED
  }

  let css
  try {
    css = await readFile(path.join(root, manifest.policy.tokenSource), 'utf8')
  } catch (cause) {
    error(`Status semantics gate could not read ${manifest.policy.tokenSource}: ${cause.message}`)
    return EXIT_GATE_FAILED
  }

  const selectors = { light: ':root', dark: '.dark' }
  const blocks = {
    light: extractBlock(css, selectors.light),
    dark: extractBlock(css, selectors.dark)
  }
  const themeBlock = extractBlock(css, '@theme inline')
  const required = [
    [selectors.light, blocks.light],
    [selectors.dark, blocks.dark],
    ['@theme inline', themeBlock]
  ]
  for (const [selector, block] of required) {
    if (block === null) {
      error(
        `Status semantics gate could not find the "${selector}" block in ${manifest.policy.tokenSource}; it cannot judge the tokens.`
      )
      return EXIT_GATE_FAILED
    }
  }

  const themes = {
    light: parseDeclarations(blocks.light),
    dark: parseDeclarations(blocks.dark)
  }
  const themeExposed = new Set(
    [...parseDeclarations(themeBlock).keys()]
      .filter((name) => name.startsWith('color-'))
      .map((name) => name.slice('color-'.length))
  )

  let debt = new Map()
  const debtPath = manifest.policy.debtBaseline
  if (debtPath) {
    try {
      debt = parseDebtBaseline(await readFile(path.join(root, debtPath), 'utf8'))
    } catch (cause) {
      error(`Status semantics gate could not read ${debtPath}: ${cause.message}`)
      return EXIT_GATE_FAILED
    }
  }

  const problems = []
  const {
    problems: stateProblems,
    measuredComparisons,
    knownDebt,
    debtUsed
  } = checkStates({
    manifest,
    themes,
    themeExposed,
    debt
  })
  problems.push(...stateProblems)
  problems.push(...checkChannelSeparation({ manifest, themes }))

  for (const phantom of findPhantomVariableReferences(css, {
    declaredElsewhere: manifest.policy.externallyDeclaredVariables ?? [],
    declaredPrefixes: manifest.policy.externallyDeclaredPrefixes ?? []
  })) {
    const key = `PHANTOM|${phantom.name}`
    const reason = debt.get(key)
    if (reason !== undefined) {
      debtUsed.add(key)
      knownDebt.push(`${key} — still referenced at line ${phantom.line} (frozen: ${reason})`)
      continue
    }
    problems.push(
      `${manifest.policy.tokenSource}:${phantom.line} references var(--${phantom.name}) but nothing declares it. With a fallback the literal always wins, so the theme switch silently does nothing. Declare it, drop the indirection, or freeze it as: ${key}`
    )
  }

  // The list may only shrink. A frozen entry that no longer offends has been fixed, and
  // leaving it in turns the baseline into a permanent excuse that stops ratcheting.
  for (const key of debt.keys()) {
    if (!debtUsed.has(key)) {
      problems.push(
        `${debtPath} freezes "${key}" but it no longer fails — delete the line. A baseline that outlives its debts stops being a ratchet.`
      )
    }
  }

  const consumers = manifest.policy.tokenConsumers ?? []
  const consumerResult = await checkTokenConsumers({ root, css, consumers })
  problems.push(...consumerResult.problems)

  // Floors, so a gate that silently stopped seeing anything cannot report a clean bill.
  if (manifest.states.length < manifest.policy.minimumStates) {
    problems.push(
      `manifest declares ${manifest.states.length} states, expected at least ${manifest.policy.minimumStates}; entries may have been dropped`
    )
  }
  if (measuredComparisons === 0 && manifest.states.some((s) => s.contrast === 'measured')) {
    problems.push(
      'no contrast comparison was measured although states declare "measured" — the token parser is no longer seeing main.css'
    )
  }

  if (problems.length > 0) {
    error(`Status semantics has ${problems.length} problem(s):`)
    for (const problem of problems) {
      error(`  - ${problem}`)
    }
    return EXIT_INVALID
  }

  for (const entry of knownDebt) {
    log(`  known contrast debt: ${entry}`)
  }
  log(
    `Status semantics: ${manifest.states.length} states, ${measuredComparisons} contrast measurements, ${Object.keys(manifest.channels).length} channels separated, ${consumerResult.checked} token reference(s) in ${consumers.length} consumer(s), ${knownDebt.length} frozen debt(s).`
  )
  return EXIT_OK
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main({ root: path.join(import.meta.dirname, '..', '..') }))
}
