import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { parse } from 'jsonc-parser'

/**
 * No value on the Workspace surface without a producer.
 *
 * A screen can claim an agent is online, which model answered, where it runs, how much memory it
 * uses, how many tasks it holds — and every one of those reads as fact to a person. The Workspace
 * shows only what an owner decides (config/workspace-surface-claims.jsonc). This gate keeps it that
 * way for the next screen, by what the code DOES:
 *
 *   R1  every claim site — a `ContextRow`, the surface's own claim primitive — carries an identity
 *       and is classified to a producer that exists, is exported and reaches the surface, plus the
 *       unknown state the consumer renders when the producer has no answer;
 *   R2  a status colour (the green of "ready", the red of "refused") appears only inside a tone map
 *       keyed by a registered presenter's tone type — a hard-coded green dot has no producer;
 *   R3  no model or host identifier is written into a surface file — those are facts main reports.
 *
 * Floors on claim sites and tone maps stop a scanner that silently matched nothing from reporting
 * a clean bill; a classification whose site is gone is stale and fails too.
 */

export const CONFIG_PATH = 'config/workspace-surface-claims.jsonc'
// ClaimValue is the inline form for dense surfaces (a count in a heading); same identity rule.
export const CLAIM_PRIMITIVES = Object.freeze(['ContextRow', 'ClaimValue'])
export const MIN_CLAIM_SITES = 10
export const MIN_TONE_MAPS = 3

export const STATUS_COLOUR =
  /--status-(?:success|warning|danger|error|info)\b|\b(?:bg|text|ring|border|fill|stroke|outline)-(?:green|emerald|lime|teal|red|rose|amber|yellow|orange)-\d{2,3}\b/
export const MODEL_OR_HOST =
  /\b(?:gpt-[\w.]+|claude-[\w.-]+|qwen[\w.-]*|llama[\w.-]*|gemini-[\w.-]+|mistral[\w.-]*|deepseek[\w.-]*|o[134]-(?:mini|pro)|sonnet|opus|haiku|gex44)\b/i

const EXPORT_OF = (symbol) =>
  new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|let|type|interface|class|enum)\\s+${symbol}\\b`
  )

/** String literals ('..', "..", `..` without substitutions) with their line numbers. */
export function stringLiterals(source) {
  const out = []
  const pattern = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
  for (const match of source.matchAll(pattern)) {
    // A template with substitutions is checked as text too: a colour inside it is still literal.
    out.push({ text: match[2], index: match.index, line: lineOf(source, match.index) })
  }
  return out
}

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line++
    }
  }
  return line
}

/** The attribute text of every `<Name ...>` / `<Name ... />` opening tag, braces balanced. */
export function jsxOpeningTags(source, name) {
  const tags = []
  const opener = new RegExp(`<${name}(?=[\\s/>])`, 'g')
  for (const match of source.matchAll(opener)) {
    let depth = 0
    let quote = null
    let end = -1
    for (let i = match.index + match[0].length; i < source.length; i++) {
      const ch = source[i]
      if (quote) {
        if (ch === '\\') {
          i++
        } else if (ch === quote) {
          quote = null
        }
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
      } else if (ch === '>' && depth === 0) {
        end = i
        break
      }
    }
    if (end !== -1) {
      tags.push({
        attributes: source.slice(match.index + match[0].length, end),
        line: lineOf(source, match.index)
      })
    }
  }
  return tags
}

/** `testId="x"` → "x"; an expression or a missing testId → null (an unidentifiable claim). */
export function literalTestId(attributes) {
  const match = /\btestId\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*['"]([^'"]*)['"]\s*\})/.exec(attributes)
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

/**
 * Tone maps: `const X: Record<T, string> = { ... }` blocks, with the key type T and their extent.
 * Only a map keyed by a presenter's tone type may hold a status colour.
 */
export function toneMaps(source) {
  const maps = []
  const opener = /\bconst\s+\w+\s*:\s*Record<\s*(\w+)\s*,\s*string\s*>\s*=\s*\{/g
  for (const match of source.matchAll(opener)) {
    const start = match.index + match[0].length - 1
    let depth = 0
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') {
        depth++
      } else if (source[i] === '}') {
        depth--
        if (depth === 0) {
          maps.push({ toneType: match[1], start, end: i, line: lineOf(source, match.index) })
          break
        }
      }
    }
  }
  return maps
}

/** Named imports of a symbol and the specifier they come from. */
export function importsOf(source) {
  const out = []
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    for (const raw of match[1].split(',')) {
      const name = raw
        .replace(/\btype\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim()
      if (name) {
        out.push({ name, specifier: match[2] })
      }
    }
  }
  const bare =
    /(?:import|export)\s+(?:type\s+)?(?:\*\s+as\s+\w+\s+|\w+\s+)?from\s+['"]([^'"]+)['"]/g
  for (const match of source.matchAll(bare)) {
    out.push({ name: null, specifier: match[1] })
  }
  return out
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

/** Repo-relative module path an import specifier resolves to, or null (a package). */
export function resolveSpecifier(fromFile, specifier, exists) {
  let base
  if (specifier.startsWith('@/')) {
    base = `src/renderer/src/${specifier.slice(2)}`
  } else if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  } else {
    return null
  }
  for (const suffix of CANDIDATE_SUFFIXES) {
    if (exists(base + suffix)) {
      return base + suffix
    }
  }
  return null
}

/**
 * The whole judgement, pure: `files` maps repo-relative surface paths to source, `read` returns
 * any repo file's source or null.
 */
export function evaluateSurfaceClaims({ config, files, read }) {
  const failures = []
  const exists = (p) => read(p) !== null
  const presenterTypes = new Map(
    (config.presenters ?? []).map((presenter) => [presenter.toneType, presenter.module])
  )
  for (const [toneType, module] of presenterTypes) {
    const source = read(module)
    if (source === null || !EXPORT_OF(toneType).test(source)) {
      failures.push(`presenter ${module} does not export tone type ${toneType}`)
    }
  }

  const sites = []
  let toneMapCount = 0
  const importedModules = new Set()
  for (const [file, source] of files) {
    for (const entry of importsOf(source)) {
      const resolved = resolveSpecifier(file, entry.specifier, exists)
      if (resolved) {
        importedModules.add(resolved)
      }
    }

    for (const primitive of CLAIM_PRIMITIVES) {
      for (const tag of jsxOpeningTags(source, primitive)) {
        const testId = literalTestId(tag.attributes)
        if (testId === null) {
          failures.push(
            `${file}:${tag.line} ${primitive} has no literal testId — a claim nobody can classify`
          )
          continue
        }
        sites.push({ file, testId, line: tag.line })
      }
    }

    const maps = toneMaps(source)
    const presenterImports = new Set(
      importsOf(source)
        .filter(
          (entry) =>
            entry.name !== null &&
            presenterTypes.has(entry.name) &&
            resolveSpecifier(file, entry.specifier, exists) === presenterTypes.get(entry.name)
        )
        .map((entry) => entry.name)
    )
    for (const literal of stringLiterals(source)) {
      if (STATUS_COLOUR.test(literal.text)) {
        const owner = maps.find((map) => literal.index > map.start && literal.index < map.end)
        if (!owner || !presenterImports.has(owner.toneType)) {
          failures.push(
            `${file}:${literal.line} status colour "${literal.text}" outside a presenter tone map — a status with no producer`
          )
        }
      }
      if (MODEL_OR_HOST.test(literal.text)) {
        failures.push(
          `${file}:${literal.line} "${literal.text}" names a model or host — that is main's fact to report, not the surface's to write`
        )
      }
    }
    for (const map of maps) {
      if (presenterImports.has(map.toneType)) {
        toneMapCount++
      }
    }
  }

  const claims = config.claims ?? {}
  const sitesById = new Map()
  for (const site of sites) {
    if (!sitesById.has(site.testId)) {
      sitesById.set(site.testId, [])
    }
    sitesById.get(site.testId).push(site)
  }
  for (const [testId, found] of sitesById) {
    const claim = claims[testId]
    if (!claim) {
      failures.push(
        `${found[0].file}:${found[0].line} claim "${testId}" is not classified in ${CONFIG_PATH}`
      )
      continue
    }
    if (typeof claim.why !== 'string' || claim.why.trim().length < 12) {
      failures.push(`claim "${testId}" needs a "why" someone can disagree with`)
    }
    const consumer = found[0].file
    if (claim.absent !== 'omitted') {
      if (typeof claim.absent !== 'string' || !files.get(consumer)?.includes(`'${claim.absent}'`)) {
        failures.push(
          `claim "${testId}": ${consumer} never renders its unknown state "${claim.absent}"`
        )
      }
    }
    if (claim.producer === null) {
      if (claim.absent === 'omitted') {
        failures.push(
          `claim "${testId}" has no producer, so it must state its unknown, not hide it`
        )
      }
      continue
    }
    const [module, symbol] = String(claim.producer).split('#')
    const source = read(module)
    if (source === null) {
      failures.push(`claim "${testId}": producer module ${module} does not exist`)
    } else if (!symbol || !EXPORT_OF(symbol).test(source)) {
      failures.push(`claim "${testId}": ${module} does not export ${symbol}`)
    } else if (!importedModules.has(module)) {
      failures.push(`claim "${testId}": producer ${module} is not imported by any surface file`)
    }
  }
  for (const testId of Object.keys(claims)) {
    if (!sitesById.has(testId)) {
      failures.push(`claim "${testId}" is classified but no surface renders it — stale entry`)
    }
  }

  if (sites.length < MIN_CLAIM_SITES) {
    failures.push(
      `found ${sites.length} claim sites, expected at least ${MIN_CLAIM_SITES}; the sweep may have stopped seeing the surface`
    )
  }
  if (toneMapCount < MIN_TONE_MAPS) {
    failures.push(
      `found ${toneMapCount} presenter tone maps, expected at least ${MIN_TONE_MAPS}; the sweep may have stopped seeing them`
    )
  }
  return { failures, siteCount: sites.length, toneMapCount, fileCount: files.size }
}

async function readRepoFile(root, relative) {
  try {
    return await fs.readFile(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

async function collectSurfaceFiles(root, surface, out) {
  const absolute = path.join(root, surface)
  let stat
  try {
    stat = await fs.stat(absolute)
  } catch {
    return false
  }
  if (stat.isFile()) {
    out.push(surface)
    return true
  }
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    const relative = `${surface}/${entry.name}`
    if (entry.isDirectory()) {
      await collectSurfaceFiles(root, relative, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(relative)
    }
  }
  return true
}

export async function main(root = process.cwd()) {
  const configText = await readRepoFile(root, CONFIG_PATH)
  if (configText === null) {
    console.error(`check-workspace-surface-claims: ${CONFIG_PATH} is missing`)
    return 1
  }
  const config = parse(configText)
  const list = []
  const missing = []
  for (const surface of config.surfaces ?? []) {
    if (!(await collectSurfaceFiles(root, surface, list))) {
      missing.push(surface)
    }
  }
  const files = new Map()
  for (const file of list) {
    files.set(file, await readRepoFile(root, file))
  }
  // Every module the judgement may look at, read once, synchronously served afterwards.
  const cache = new Map()
  const wanted = new Set([
    ...(config.presenters ?? []).map((presenter) => presenter.module),
    ...Object.values(config.claims ?? {})
      .map((claim) => (claim.producer ? String(claim.producer).split('#')[0] : null))
      .filter(Boolean)
  ])
  for (const [file, source] of files) {
    for (const entry of importsOf(source)) {
      const specifier = entry.specifier
      const base = specifier.startsWith('@/')
        ? `src/renderer/src/${specifier.slice(2)}`
        : specifier.startsWith('.')
          ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
          : null
      if (base) {
        for (const suffix of CANDIDATE_SUFFIXES) {
          wanted.add(base + suffix)
        }
      }
    }
  }
  for (const file of wanted) {
    cache.set(file, await readRepoFile(root, file))
  }
  const read = (relative) => files.get(relative) ?? cache.get(relative) ?? null

  const result = evaluateSurfaceClaims({ config, files, read })
  const failures = [
    ...missing.map((surface) => `surface ${surface} does not exist — stale entry`),
    ...result.failures
  ]
  if (failures.length > 0) {
    console.error(`check-workspace-surface-claims: ${failures.length} problem(s)`)
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    return 1
  }
  console.log(
    `check-workspace-surface-claims: ${result.fileCount} surface files, ${result.siteCount} claim sites classified, ${result.toneMapCount} presenter tone maps, no status or model/host literal outside them.`
  )
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
