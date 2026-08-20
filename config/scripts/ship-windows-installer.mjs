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
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const BUILT_ARTIFACT = 'orca-x-windows-setup.exe'
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
console.error(`[ship] Building Orca X from ${source.commit}${source.dirty ? ' (+ uncommitted changes)' : ''}`)

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const build = spawnSync(pnpm, ['run', 'build:win'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
if (build.status !== 0) {
  fail(`Packaging failed with exit code ${build.status}. Nothing was copied to the Desktop.`)
}

const builtPath = join(repoRoot, 'dist', BUILT_ARTIFACT)
if (!existsSync(builtPath)) {
  fail(`Packaging reported success but produced no ${BUILT_ARTIFACT} in dist/.`)
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
console.error(`\n[ship] ${destinationPath}`)
console.error(`[ship] ${megabytes} MB  ·  built from ${source.commit}`)
console.error(`[ship] SHA-256 ${shippedHash}`)
if (source.dirty) {
  console.error('[ship] Built with uncommitted changes in the working tree.')
}
