import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * A phone row that stands in for a remote effect must say only what is known about that effect.
 *
 * SEND-P0 (2026-10-27): a paste-sized chat message sat unsubmitted on Claude Code's input line
 * while the phone showed a normal "sent" bubble. The host had accepted the PTY write; nothing had
 * admitted a turn. The fix put every pending chat bubble on one presenter,
 * `mobile/src/session/mobile-native-chat-delivery-evidence.ts` ('written' -> 'unconfirmed', with
 * the transcript message itself as delivery). This gate keeps a second surface from minting its
 * own optimistic row and rendering a write receipt as delivery again.
 *
 * The population is found by what code does — it mints a locally-identified stand-in row
 * (`pending-${...}`, `local-${...}`, ...) — never by searching for the presenter. Each such file
 * either reaches the presenter (directly or through one relative import) or is listed in the
 * receipt baseline, which is for rows built only after the host returned the created object's own
 * success (e.g. a GitHub comment create). The baseline only shrinks.
 */
export const SCAN_ROOTS = ['mobile/app', 'mobile/src']
export const PRESENTER_MODULE = 'mobile/src/session/mobile-native-chat-delivery-evidence.ts'
export const BASELINE_PATH = path.join('config', 'mobile-remote-effect-receipt-baseline.txt')
// Why a floor: a sweep that stopped matching reports the same clean bill as a healthy estate.
// Seven mint sites exist on 2026-10-27; five is the alarm line.
export const MIN_MINT_SITES = 5

const MINT_PATTERN = /`(?:pending|optimistic|local|echo|temp|tmp)-\$\{/g

export function countMintSites(source) {
  return (source.match(MINT_PATTERN) ?? []).length
}

/** Relative import specifiers, `import ... from './x'` and `import './x'`. */
export function relativeImports(source) {
  const specifiers = []
  const pattern = /(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) {
    specifiers.push(match[1])
  }
  return specifiers
}

export function parseBaseline(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  )
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

/** Resolve a relative specifier against a repo-relative file, trying the TS extensions. */
export function resolveSpecifier(fromFile, specifier, exists) {
  const base = toPosix(
    path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
  )
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return candidates.find((candidate) => exists(candidate)) ?? null
}

/**
 * Pure evaluation so the test can drive every branch.
 * `files` maps repo-relative path -> source for every scanned non-test file.
 */
export function evaluateBubbles({ files, baseline, minMintSites = MIN_MINT_SITES }) {
  const exists = (file) => Object.hasOwn(files, file)
  const reachesPresenter = (file) => {
    const direct = relativeImports(files[file])
      .map((spec) => resolveSpecifier(file, spec, exists))
      .filter(Boolean)
    if (direct.includes(PRESENTER_MODULE)) {
      return true
    }
    return direct.some((hop) =>
      relativeImports(files[hop]).some(
        (spec) => resolveSpecifier(hop, spec, exists) === PRESENTER_MODULE
      )
    )
  }

  let mintSites = 0
  const minting = []
  for (const [file, source] of Object.entries(files)) {
    const count = countMintSites(source)
    if (count > 0) {
      mintSites += count
      minting.push(file)
    }
  }

  const failures = []
  if (!exists(PRESENTER_MODULE)) {
    failures.push({
      kind: 'presenter-missing',
      detail: `${PRESENTER_MODULE} is not in the sweep`
    })
  }
  if (mintSites < minMintSites) {
    failures.push({
      kind: 'population-floor',
      detail: `found only ${mintSites} stand-in row mint sites (expected at least ${minMintSites}) — the sweep is probably broken, not the code`
    })
  }
  const evidenced = []
  for (const file of minting.sort()) {
    if (reachesPresenter(file)) {
      evidenced.push(file)
      continue
    }
    if (!baseline.has(file)) {
      failures.push({
        kind: 'unevidenced-bubble',
        detail: `${file} mints a stand-in row for a remote effect but never takes its state from ${PRESENTER_MODULE} — a write receipt is not delivery`
      })
    }
  }
  for (const file of baseline) {
    if (!minting.includes(file) || evidenced.includes(file)) {
      failures.push({
        kind: 'stale-baseline',
        detail: `${file} is in ${toPosix(BASELINE_PATH)} but no longer needs to be — delete the line (the list only shrinks)`
      })
    }
  }
  return { failures, mintSites, minting, evidenced }
}

/** Positive control: the detector must flag an unevidenced mint and clear an evidenced one. */
export function selfCheck() {
  const files = {
    [PRESENTER_MODULE]: 'export type D = 1\n',
    'mobile/src/session/hop.ts':
      "import type { D } from './mobile-native-chat-delivery-evidence'\n",
    'mobile/src/session/good.ts': "import { x } from './hop'\nconst id = `pending-${n}`\n",
    'mobile/src/session/bad.tsx': 'const row = { id: `optimistic-${n}` }\n'
  }
  const result = evaluateBubbles({
    files,
    baseline: new Set(),
    minMintSites: 1
  })
  const flagged = result.failures
    .filter((f) => f.kind === 'unevidenced-bubble')
    .map((f) => f.detail)
  const failures = []
  if (!flagged.some((d) => d.startsWith('mobile/src/session/bad.tsx'))) {
    failures.push('detector missed an unevidenced stand-in row')
  }
  if (flagged.some((d) => d.startsWith('mobile/src/session/good.ts'))) {
    failures.push('detector did not follow a one-hop import to the presenter')
  }
  return failures
}

async function collectSourceFiles(root, dir, out) {
  let entries
  try {
    entries = await fs.readdir(path.join(root, dir), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') {
        continue
      }
      await collectSourceFiles(root, relative, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) {
      continue
    }
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) {
      continue
    }
    out.push(toPosix(relative))
  }
  return out
}

async function main() {
  const repoRoot = process.cwd()
  const selfCheckFailures = selfCheck()
  if (selfCheckFailures.length > 0) {
    console.error('Mobile remote-effect bubble gate: the detector itself is broken.')
    for (const failure of selfCheckFailures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  let baseline = new Set()
  try {
    baseline = parseBaseline(await fs.readFile(path.join(repoRoot, BASELINE_PATH), 'utf8'))
  } catch {
    // An absent baseline grandfathers nothing; every receipt-backed surface then fails loudly.
  }

  const paths = []
  for (const root of SCAN_ROOTS) {
    await collectSourceFiles(repoRoot, root, paths)
  }
  const files = {}
  for (const file of paths) {
    files[file] = await fs.readFile(path.join(repoRoot, file), 'utf8')
  }

  const result = evaluateBubbles({ files, baseline })
  if (result.failures.length > 0) {
    console.error('Mobile remote-effect bubble check failed:')
    for (const failure of result.failures) {
      console.error(`  - ${failure.detail}`)
    }
    process.exitCode = 1
    return
  }
  console.log(
    `Mobile remote-effect bubbles: ${result.mintSites} stand-in row sites in ${result.minting.length} files; ${result.evidenced.length} on the delivery-evidence presenter, ${baseline.size} receipt-backed.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
