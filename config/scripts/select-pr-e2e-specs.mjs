// Selects the E2E specs a PR must run from the files it changed. See config/e2e-impact-map.jsonc.
// Dependency-free on purpose: the detector job runs before any install.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const IMPACT_MAP_PATH = path.join('config', 'e2e-impact-map.jsonc')

export function loadImpactMap(root = process.cwd()) {
  const text = fs.readFileSync(path.join(root, IMPACT_MAP_PATH), 'utf8')
  const json = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
  return JSON.parse(json)
}

/** `**` crosses directories, `*` does not. Everything else is literal. */
export function globToRegExp(glob) {
  let pattern = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      pattern += '.*'
      index++
    } else if (char === '*') {
      pattern += '[^/]*'
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${pattern}$`)
}

const matchesAny = (file, globs) => globs.some((glob) => globToRegExp(glob).test(file))

/**
 * Every changed file lands in exactly one bucket, and the reason is kept so a CI log can say why
 * a spec ran: `spec`, `mapped:<entry>`, `unknown-impact`, `shared-infrastructure` or `ignored`.
 */
export function selectPrE2eSpecs(changedFiles, map) {
  const specs = new Set()
  const reasons = []
  let needsFloor = false
  for (const raw of changedFiles) {
    const file = raw.replaceAll('\\', '/').trim()
    if (!file) {
      continue
    }
    if (/^tests\/e2e\/.*\.spec\.ts$/.test(file)) {
      specs.add(file)
      reasons.push({ file, reason: 'spec' })
      continue
    }
    const entries = map.entries.filter((entry) => matchesAny(file, entry.sources))
    if (entries.length > 0) {
      for (const entry of entries) {
        entry.specs.forEach((spec) => specs.add(spec))
      }
      reasons.push({ file, reason: `mapped:${entries.map((entry) => entry.id).join(',')}` })
      continue
    }
    if (matchesAny(file, map.sharedInfrastructure)) {
      needsFloor = true
      reasons.push({ file, reason: 'shared-infrastructure' })
      continue
    }
    if (map.productionRoots.some((prefix) => file.startsWith(prefix))) {
      needsFloor = true
      reasons.push({ file, reason: 'unknown-impact' })
      continue
    }
    reasons.push({ file, reason: 'ignored' })
  }
  if (needsFloor) {
    map.unknownImpactSpecs.forEach((spec) => specs.add(spec))
  }
  return { specs: [...specs].sort(), reasons }
}

/** A map that names a missing spec, or a pattern matching nothing, describes code that is gone. */
export function validateImpactMap(map, listFiles) {
  const files = listFiles()
  const exists = new Set(files)
  const problems = []
  const specsNamed = [...map.unknownImpactSpecs, ...map.entries.flatMap((entry) => entry.specs)]
  for (const spec of specsNamed) {
    if (!exists.has(spec)) {
      problems.push(`names spec ${spec}, which does not exist`)
    }
  }
  for (const entry of map.entries) {
    for (const glob of entry.sources) {
      if (!files.some((file) => globToRegExp(glob).test(file))) {
        problems.push(`${entry.id}: source pattern ${glob} matches no file`)
      }
    }
  }
  return problems
}

export function listRepoFiles(root = process.cwd()) {
  const out = []
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (dirent.name === 'node_modules' || dirent.name.startsWith('.')) {
        continue
      }
      const rel = dir ? `${dir}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        walk(rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk('src')
  walk('tests')
  return out
}

function main() {
  const root = process.cwd()
  const map = loadImpactMap(root)
  const problems = validateImpactMap(map, () => listRepoFiles(root))
  if (problems.length > 0) {
    console.error(`e2e impact map is stale:\n  ${problems.join('\n  ')}`)
    process.exit(2)
  }
  const changed = fs.readFileSync(0, 'utf8').split(/\r?\n/)
  const { specs, reasons } = selectPrE2eSpecs(changed, map)
  for (const { file, reason } of reasons) {
    console.error(`${reason.padEnd(28)} ${file}`)
  }
  process.stdout.write(`${JSON.stringify(specs)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
