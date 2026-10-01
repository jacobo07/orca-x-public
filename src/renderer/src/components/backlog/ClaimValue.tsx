import { cn } from '@/lib/utils'

/**
 * A ledger number the Backlog claims. The literal `testId` is its identity in
 * config/workspace-surface-claims.jsonc; the text is the bare numeral so the DOM stays
 * locale-independent, and the words around it belong to the consumer.
 */
export function ClaimValue({
  testId,
  value,
  className
}: {
  testId: string
  value: number
  className?: string
}): React.JSX.Element {
  return (
    <span data-testid={testId} data-count={value} className={cn('tabular-nums', className)}>
      {String(value)}
    </span>
  )
}
