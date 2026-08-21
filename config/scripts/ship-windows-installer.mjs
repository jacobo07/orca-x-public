/**
 * Build the Windows installer and put it on the Desktop, ready to run.
 *
 * Why a script rather than a documented sequence of commands: a stale installer is indistinguishable
 * from a broken feature. It launches, it has the product's name on it, and it silently predates the
 * fix you are looking for. Every check here exists to make that outcome impossible rather than
 * unlikely.
 *
 * Nothing is inferred from an exit code. electron-builder returning 0 while leaving a previous
 * artifact untouched looks identical, from the outside, to a successful build.
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const BUILT_ARTIFACT = 'orca-x-windows-setup.exe'
/**
 * Where electron-builder writes. The builder config reads the same variable and sets
 * `directories.output` from it; this side only needs to look in the right place afterwards, so the
 * two must agree. Every check below applies to whatever comes out, wherever it was written.
 */
const OUTPUT_DIR = process.env.ORCA_SHIP_OUTPUT_DIR?.trim() || 'dist'
const DESKTOP_ARTIFACT = 'Orca X Setup.exe'

function fail(message) {
  console.error(`\n[ship] ${message}`)
  process.exit(1)
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase()
}

/** The Desktop, which OneDrive relocates on many Windows installs. */
function resolveDesktop() {
  const candidates = [
    process.env.ORCA_SHIP_DESTINATION,
    process.env.OneDrive ? join(process.env.OneDrive, 'Desktop') : null,
    join(homedir(), 'Desktop')
  ].filter(Boolean)
  const desktop = candidates.find((candidate) => existsSync(candidate))
  if (!desktop) {
    fail(`No Desktop directory found. Tried:\n  ${candidates.join('\n  ')}`)
  }
  return desktop
}

/**
 * The MSVC environment script, when one is on disk and the shell has not already loaded it.
 *
 * Why this is needed at all: node-gyp finds MSVC only through `vswhere`, and a machine whose
 * Visual Studio Installer registration is broken reports no installation while holding a perfectly
 * good compiler. Sourcing vcvars sets VCINSTALLDIR, which node-gyp accepts directly. Without it the
 * native rebuild fails with "Could not find any Visual Studio installation to use" — which reads as
 * a missing toolchain rather than as a lookup that cannot see the one that is there.
 */
function findVisualStudioEnvironment() {
  if (process.platform !== 'win32' || process.env.VCINSTALLDIR) {
    return null
  }
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
  const editions = ['BuildTools', 'Community', 'Professional', 'Enterprise']
  for (const root of roots) {
    for (const edition of editions) {
      const vcvars = join(
        root,
        'Microsoft Visual Studio',
        '2022',
        edition,
        'VC',
        'Auxiliary',
        'Build',
        'vcvars64.bat'
      )
      if (existsSync(vcvars)) {
        return vcvars
      }
    }
  }
  return null
}

function runWindowsBuild() {
  const options = { cwd: repoRoot, stdio: 'inherit' }
  const vcvars = findVisualStudioEnvironment()
  if (vcvars) {
    console.log(`[ship] Using the MSVC environment from ${vcvars}`)
    // Why cmd rather than exporting the variables here: vcvars sets dozens of them, and
    // reproducing that set by hand is how a build ends up half-configured with nothing reporting it.
    // Why one shell string rather than ['cmd', '/c', ...]: passing it as an argument makes Node
    // escape the quotes around the path, and cmd then looks for a program named with the quotes in
    // it. vcvars prints its own "vswhere.exe no se reconoce" on this host and continues — that line
    // is the broken registration this exists to work around, not a failure.
    return spawnSync(`call "${vcvars}" >nul && pnpm run build:win`, { ...options, shell: true })
  }
  // Fail-open: a host with a working vswhere needs none of this, and a host with no compiler at all
  // should hear that from the build rather than from a guess made here.
  return spawnSync('pnpm.cmd', ['run', 'build:win'], { ...options, shell: true })
}

function describeSource() {
  try {
    const git = process.platform === 'win32' ? 'C:/Program Files/Git/cmd/git.exe' : 'git'
    const commit = execFileSync(git, ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8'
    }).trim()
    const dirty =
      execFileSync(git, ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.trim() && !line.includes('??')).length > 0
    return { commit, dirty }
  } catch {
    // A build from a source archive still ships; it just cannot name its commit.
    return { commit: 'unknown', dirty: false }
  }
}

const source = describeSource()
const startedAtMs = Date.now()
// Why stdout for the report and stderr only for failure: PowerShell wraps every stderr line from a
// native command in an ErrorRecord, so a successful ship that narrates itself on stderr reads as a
// failed one to anything checking $?.
console.log(
  `[ship] Building Orca X from ${source.commit}${source.dirty ? ' (+ uncommitted changes)' : ''}`
)

/**
 * Vite writes content-hashed chunks and never removes the previous build's, so `out/` accumulates
 * every bundle ever produced there — and electron-builder packs the whole directory. Observed on a
 * machine that had run a handful of e2e builds: 883 files and 63.5 MB in out/renderer/assets alone,
 * three copies of every KaTeX font, and an installer 15 MB larger than the code it contains.
 *
 * Rebuilding into a dirty directory is the failure this whole script exists to catch, so it is
 * loud: a build that cannot start clean should say so rather than ship the difference.
 */
function clearPreviousBuildOutput() {
  const outDir = join(repoRoot, 'out')
  if (!existsSync(outDir)) {
    return
  }
  try {
    rmSync(outDir, { recursive: true, force: true })
  } catch (error) {
    fail(
      `Could not clear out/ before building: ${error.message}
` +
        '        Something is holding a file there; shipping now would pack every previous build.'
    )
  }
}

clearPreviousBuildOutput()
const build = runWindowsBuild()
if (build.status !== 0) {
  fail(`Packaging failed with exit code ${build.status}. Nothing was copied to the Desktop.`)
}

const builtPath = join(repoRoot, OUTPUT_DIR, BUILT_ARTIFACT)
if (!existsSync(builtPath)) {
  fail(`Packaging reported success but produced no ${BUILT_ARTIFACT} in ${OUTPUT_DIR}/.`)
}
// Why the timestamp check: a build that skipped its packaging step leaves the previous run's
// artifact in place, and exits 0 having shipped nothing.
const builtStat = statSync(builtPath)
if (builtStat.mtimeMs < startedAtMs) {
  fail(
    `${BUILT_ARTIFACT} is older than this build (written ${new Date(builtStat.mtimeMs).toISOString()}).\n` +
      '        Packaging exited 0 without rewriting it, so the artifact is from an earlier run.'
  )
}

const destinationPath = join(resolveDesktop(), DESKTOP_ARTIFACT)
copyFileSync(builtPath, destinationPath)

// Why hashed rather than trusting copyFileSync: this is the file the user will actually run, and a
// truncated or half-written copy is exactly the failure this whole script exists to rule out.
const builtHash = sha256(builtPath)
const shippedHash = sha256(destinationPath)
if (builtHash !== shippedHash) {
  fail(`The Desktop copy does not match what was built.\n  built:   ${builtHash}\n  shipped: ${shippedHash}`)
}

const megabytes = (builtStat.size / 1024 / 1024).toFixed(1)
console.log(`\n[ship] ${destinationPath}`)
console.log(`[ship] ${megabytes} MB  ·  built from ${source.commit}`)
console.log(`[ship] SHA-256 ${shippedHash}`)
if (source.dirty) {
  console.log('[ship] Built with uncommitted changes in the working tree.')
}
