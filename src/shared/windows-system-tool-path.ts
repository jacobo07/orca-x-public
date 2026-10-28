import { win32 as pathWin32 } from 'node:path'

const DEFAULT_SYSTEM_ROOT = 'C:\\Windows'
// Why drive-qualified: 'Windows', 'C:Windows' and '\Windows' all resolve against the cwd or its drive.
const DRIVE_QUALIFIED_ROOT = /^[A-Za-z]:[\\/]/

function isDriveQualified(root: string | undefined): root is string {
  return typeof root === 'string' && DRIVE_QUALIFIED_ROOT.test(root)
}

// Why absolute: resolving a system tool through PATH would run whichever copy appears first.
export function getWindowsSystemToolPath(
  relativeSystem32Path: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const systemRoot = [env.SystemRoot, env.WINDIR].find(isDriveQualified) ?? DEFAULT_SYSTEM_ROOT
  return pathWin32.join(systemRoot, 'System32', relativeSystem32Path)
}
