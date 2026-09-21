import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Anything that materializes a provider's "this folder is trusted" artifact must first ask
 * src/main/workspace-execution-consent.ts whether the user granted it.
 *
 * That artifact is the provider's own safety control against executing untrusted repository
 * content, and it lands in the user's real home, globally and permanently. Orca used to write it
 * before every recognized spawn, keyed to "Orca launched an agent here" rather than to "the user
 * trusts this folder".
 *
 * This is a gate rather than a code-review note because of how the effect spreads. It already had
 * five call sites across desktop launch prep, desktop resume, a renderer-callable IPC channel,
 * remote worktrees and the runtime/headless host, and `preflightTrust` in src/shared/tui-agent-config.ts
 * is an OPTIONAL FIELD: a new provider that adds one line inherits the whole effect at every one of
 * those sites, silently. So the gate asks two questions — does every writer consult the authority,
 * and does every declared provider have a writer that does.
 *
 * The population is enumerated by what the code DOES (it writes one of the three artifacts), never
 * by searching for the guard. Searching for a guard finds the files that have one, which is the
 * opposite of the question.
 */
const SCAN_ROOTS = ['src']
const AUTHORITY_MODULE = 'src/main/workspace-execution-consent.ts'
const AUTHORITY_IMPORT = 'workspace-execution-consent'
const PROVIDER_CONFIG = 'src/shared/tui-agent-config.ts'
// Why a floor: a sweep that silently stopped matching reports the same clean bill as a healthy
// estate. Orca has two trust-artifact producers (local and remote); one is the alarm line.
const MIN_PRODUCERS = 2

/** True when the file WRITES one of the three provider trust artifacts. */
export function writesProviderTrustArtifact(source) {
  return (
    /\bupsertProjectTrustLevel(InContent)?\s*\(/.test(source) ||
    /['"`][^'"`]*\.workspace-trusted['"`]/.test(source) ||
    /\btrustedFolders\b\s*[=:]/.test(source)
  )
}

/**
 * The TOML helper that performs the write is a primitive, not a decision: it is handed a path by a
 * producer that has already asked. Excluding it by its own export keeps the pattern from counting
 * its declaration as a call site.
 */
export function definesTrustPrimitive(source) {
  return /export\s+function\s+upsertProjectTrustLevel/.test(source)
}

export function consultsConsentAuthority(source) {
  return new RegExp(`from\\s+['"][^'"]*${AUTHORITY_IMPORT}['"]`).test(source)
}

/** Every `preflightTrust: 'x'` declared in the shared provider table. */
export function declaredPreflightTrustPresets(source) {
  return [...source.matchAll(/preflightTrust\s*:\s*['"]([a-z0-9-]+)['"]/gi)].map((m) => m[1])
}

/** Every preset a guarded producer actually handles, read from the producers themselves. */
export function handledPresets(source) {
  return [...source.matchAll(/args\.preset\s*===\s*['"]([a-z0-9-]+)['"]/gi)].map((m) => m[1])
}

function toPosix(value) {
  return value.split(path.sep).join('/')
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
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
      continue
    }
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts')) {
      continue
    }
    out.push(toPosix(relative))
  }
  return out
}

/**
 * Positive and negative controls on SYNTHETIC subjects, so the drill keeps working on the day the
 * last real offender is fixed. A drill pinned to a real defect has an interest in that defect
 * surviving; this one cannot be fixed out from under the assertion.
 */
export function selfCheck() {
  const unguarded = `import { upsertProjectTrustLevel } from './codex/config-toml-trust'
export function markKimiProjectTrusted(p: string): void {
  upsertProjectTrustLevel(configPath, p, 'trusted')
}
`
  const guarded = `import { refusalFor } from './workspace-execution-consent'
import { upsertProjectTrustLevel } from './codex/config-toml-trust'
export function markKimiProjectTrusted(p: string): void {
  if (refusalFor({ scope: LOCAL_WORKSPACE_SCOPE, workspacePath: p, preset: 'kimi' })) return
  upsertProjectTrustLevel(configPath, p, 'trusted')
}
`
  const primitive = `export function upsertProjectTrustLevel(file: string, project: string): void {}\n`
  const cursorMarker = `const trustFile = join(trustDir, '.workspace-trusted')\n`
  const unrelated = `export function resolveWorktreePath(p: string): string { return p }\n`

  const failures = []
  if (!writesProviderTrustArtifact(unguarded) || consultsConsentAuthority(unguarded)) {
    failures.push('detector missed an unguarded trust writer')
  }
  if (!writesProviderTrustArtifact(guarded) || !consultsConsentAuthority(guarded)) {
    failures.push('detector did not recognise a guarded trust writer')
  }
  if (!definesTrustPrimitive(primitive)) {
    failures.push('detector did not recognise the trust primitive that must be excluded')
  }
  if (!writesProviderTrustArtifact(cursorMarker)) {
    failures.push('detector missed the cursor .workspace-trusted marker')
  }
  if (writesProviderTrustArtifact(unrelated)) {
    failures.push('detector flagged a file that writes no trust artifact')
  }
  if (declaredPreflightTrustPresets(`preflightTrust: 'kimi'`).join() !== 'kimi') {
    failures.push('preflightTrust declaration reader is broken')
  }
  if (declaredPreflightTrustPresets(`expectedProcess: 'codex'`).length !== 0) {
    failures.push('preflightTrust declaration reader matched an unrelated field')
  }
  return failures
}

async function main() {
  const repoRoot = process.cwd()
  const selfCheckFailures = selfCheck()
  if (selfCheckFailures.length > 0) {
    console.error('Workspace trust authority gate: the detector itself is broken.')
    for (const failure of selfCheckFailures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  const files = []
  for (const root of SCAN_ROOTS) {
    await collectSourceFiles(repoRoot, root, files)
  }

  const producers = []
  const unguarded = []
  let handled = []
  for (const file of files) {
    if (file === AUTHORITY_MODULE) {
      continue
    }
    const source = await fs.readFile(path.join(repoRoot, file), 'utf8')
    if (definesTrustPrimitive(source) || !writesProviderTrustArtifact(source)) {
      continue
    }
    producers.push(file)
    handled = [...handled, ...handledPresets(source)]
    if (!consultsConsentAuthority(source)) {
      unguarded.push(file)
    }
  }

  const failures = []
  if (producers.length < MIN_PRODUCERS) {
    failures.push(
      `found only ${producers.length} trust-artifact producers (expected at least ${MIN_PRODUCERS}) — the sweep is probably broken, not the code`
    )
  }

  for (const file of unguarded) {
    failures.push(
      `${file} writes a provider trust artifact without consulting ${AUTHORITY_MODULE} — a workspace the user never consented to would be marked trusted in their real home`
    )
  }

  let declared = []
  try {
    declared = declaredPreflightTrustPresets(
      await fs.readFile(path.join(repoRoot, PROVIDER_CONFIG), 'utf8')
    )
  } catch {
    failures.push(`could not read ${PROVIDER_CONFIG} — the provider declaration sweep saw nothing`)
  }
  if (declared.length === 0 && failures.length === 0) {
    failures.push(
      `${PROVIDER_CONFIG} declared no preflightTrust presets — an empty expectation is satisfied by an empty reality, so this reads as a broken sweep`
    )
  }
  const handledSet = new Set(handled)
  for (const preset of new Set(declared)) {
    if (!handledSet.has(preset)) {
      failures.push(
        `${PROVIDER_CONFIG} declares preflightTrust: '${preset}' but no guarded producer handles it — a new provider must opt into the trust boundary explicitly, never inherit it by adding a field`
      )
    }
  }

  if (failures.length > 0) {
    console.error('Workspace trust authority check failed:')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
    return
  }

  console.log(
    `Workspace trust authority: ${producers.length} trust-artifact producers, all gated; ${new Set(declared).size} declared providers, all handled by a gated producer.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
