export type MobileSessionIdentityInput = {
  // The old header meta text: tab count, loading, or a connection/retry label.
  statusText: string
  // True while not connected or still loading tabs, when statusText says more than the tab.
  showStatusText: boolean
  tabTitle: string | null
  hostName: string | null
  worktreePath: string | null
  worktreeName: string | null
  tabCount: number
}

export type MobileSessionIdentity = {
  segments: string[]
  accessibilityLabel: string
}

/** Last two path segments, with an ellipsis only when something was cut. */
export function formatWorktreePathTail(path: string): string | null {
  const trimmed = path.trim()
  const parts = trimmed.split(/[\\/]+/).filter((part) => part.length > 0)
  if (parts.length === 0) {
    return null
  }
  const tail = parts.slice(-2).join('/')
  if (parts.length > 2) {
    return `…/${tail}`
  }
  return trimmed.startsWith('/') ? `/${tail}` : tail
}

function present(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function buildMobileSessionIdentity(
  input: MobileSessionIdentityInput
): MobileSessionIdentity {
  const tabTitle = present(input.tabTitle)
  const lead = input.showStatusText || !tabTitle ? input.statusText : tabTitle
  const hostName = present(input.hostName)
  const path = present(input.worktreePath)
  const pathTail = path ? formatWorktreePathTail(path) : null
  const segments = [lead, hostName, pathTail].filter((part): part is string => part !== null)

  const tabCount = input.showStatusText
    ? null
    : input.tabCount === 1
      ? '1 tab'
      : `${input.tabCount} tabs`
  const accessibilityLabel = [
    present(input.worktreeName),
    lead,
    tabCount && tabCount !== lead ? tabCount : null,
    hostName ? `host ${hostName}` : null,
    path
  ]
    .filter((part): part is string => part !== null)
    .join(', ')

  return { segments, accessibilityLabel }
}
