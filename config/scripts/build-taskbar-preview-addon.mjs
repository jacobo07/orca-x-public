#!/usr/bin/env node
/**
 * Build the Windows taskbar-preview addon.
 *
 * Why this is not `rebuild-native-deps.mjs`: that script drives @electron/rebuild over packages in
 * node_modules. This addon is first-party source in the repo, and being Node-API it is ABI-stable
 * across runtimes, so it needs compiling for the target platform and architecture but not against a
 * particular Electron build.
 *
 * Why it is not part of postinstall: a contributor without MSVC installed must still be able to
 * install and run Orca. The taskbar preview degrades to unavailable; nothing else changes. Packaging
 * a Windows artifact does require it, and there the failure is fatal.
 *
 * The vcvars fallback exists because `vswhere.exe` returns an empty result with exit code 0 on at
 * least one real developer machine that has a working MSVC toolchain. node-gyp trusts vswhere, so it
 * reports "Could not find any Visual Studio installation to use" while the compiler sits on disk.
 * node-gyp takes VCINSTALLDIR as an override, and a vcvars environment supplies exactly that.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const projectDir = resolve(import.meta.dirname, '..', '..')
const requireFromProject = createRequire(join(projectDir, 'package.json'))
const addonDir = join(projectDir, 'native', 'orca-taskbar-preview')
const TASKBAR_PREVIEW_ADDON_FILENAME = 'orca_taskbar_preview.node'
const artifactPath = join(addonDir, 'build', 'Release', TASKBAR_PREVIEW_ADDON_FILENAME)

const VSWHERE_BLIND_SIGNATURE = /Could not find any Visual Studio installation to use/i

const VCVARS_CANDIDATES = [
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Community',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Professional',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\Enterprise'
]

function resolveNodeGyp() {
  const hoisted = join(projectDir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  if (existsSync(hoisted)) {
    return hoisted
  }
  // pnpm keeps node-gyp in its content-addressed store rather than hoisting it, so resolve through
  // the package rather than guessing the version-stamped directory name.
  try {
    return requireFromProject.resolve('node-gyp/bin/node-gyp.js')
  } catch {
    return null
  }
}

function runNodeGyp(nodeGypPath) {
  return spawnSync(process.execPath, [nodeGypPath, 'configure', 'build'], {
    cwd: addonDir,
    encoding: 'utf8',
    env: process.env
  })
}

function findVcvarsBatch() {
  for (const root of VCVARS_CANDIDATES) {
    const batch = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
    if (existsSync(batch)) {
      return batch
    }
  }
  return null
}

function runNodeGypUnderVcvars(nodeGypPath, vcvarsBatch) {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-taskbar-addon-'))
  const batchPath = join(scratch, 'build.bat')
  writeFileSync(
    batchPath,
    [
      '@echo off',
      `call "${vcvarsBatch}" >nul`,
      'if errorlevel 1 exit /b 90',
      `cd /d "${addonDir}"`,
      `"${process.execPath}" "${nodeGypPath}" configure build`,
      'exit /b %ERRORLEVEL%'
    ].join('\r\n'),
    'utf8'
  )
  try {
    return spawnSync('cmd.exe', ['/c', batchPath], { encoding: 'utf8', env: process.env })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function fail(message, detail) {
  console.error(`[taskbar-preview-addon] ${message}`)
  if (detail) {
    console.error(detail.trim())
  }
  process.exit(1)
}

if (process.platform !== 'win32') {
  console.log('[taskbar-preview-addon] Not a Windows host; nothing to build.')
  process.exit(0)
}

const nodeGypPath = resolveNodeGyp()
if (!nodeGypPath) {
  fail('Could not resolve node-gyp. Run pnpm install first.')
}

let result = runNodeGyp(nodeGypPath)
const firstOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

if (result.status !== 0 && VSWHERE_BLIND_SIGNATURE.test(firstOutput) && !process.env.VCINSTALLDIR) {
  const vcvarsBatch = findVcvarsBatch()
  if (!vcvarsBatch) {
    fail(
      'node-gyp found no Visual Studio installation and no vcvars64.bat was found either. ' +
        'Install the MSVC build tools, or set VCINSTALLDIR if they live somewhere unusual.',
      firstOutput
    )
  }
  console.log(
    `[taskbar-preview-addon] vswhere reported no Visual Studio; retrying under ${vcvarsBatch}.`
  )
  result = runNodeGypUnderVcvars(nodeGypPath, vcvarsBatch)
}

if (result.status !== 0) {
  fail(
    `node-gyp exited with status ${result.status}.`,
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  )
}

if (!existsSync(artifactPath)) {
  // A zero exit with no artifact is the shape that turns a broken build into a silently missing
  // feature at runtime, so it is treated as a failure here rather than discovered in packaging.
  fail(`node-gyp reported success but ${artifactPath} does not exist.`)
}

console.log(`[taskbar-preview-addon] Built ${artifactPath}`)
