import { cn } from '@/lib/utils'

/**
 * An inline value the surface claims. The literal `testId` is its identity in
 * config/workspace-surface-claims.jsonc, which names the producer that decides it.
 */
export function ClaimValue({
  testId,
  className,
  title,
  children
}: {
  testId: string
  className?: string
  /** The whole value, for a surface that truncates it. */
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span data-testid={testId} className={cn('tabular-nums', className)} title={title}>
      {children}
    </span>
  )
}
