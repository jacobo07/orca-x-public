import { win32 as pathWin32 } from 'node:path'

// Why absolute: resolving a system tool through PATH would run whichever copy appears first.
export function getWindowsSystemToolPath(
  relativeSystem32Path: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  return pathWin32.join(systemRoot, 'System32', relativeSystem32Path)
}
