import type { ContractReadState } from '../../../../shared/environment-requirements-measurement'

export type ContractComparisonBlock = {
  hostKey: string
  contract: ContractReadState
  contentHash?: string
}

// An unreadable or unparseable contract has no content to compare, so it takes no side.
function comparableValue(block: ContractComparisonBlock): string | null {
  if (block.contract === 'parsed') {
    return block.contentHash ? `parsed:${block.contentHash}` : null
  }
  return block.contract === 'absent' ? 'absent' : null
}

/**
 * Which other hosts' contracts differ from each host's. Contracts are only compared, never merged:
 * a host appears in the result only when at least one comparable host holds a different one.
 */
export function compareContractSources(
  blocks: readonly ContractComparisonBlock[]
): Map<string, string[]> {
  const differs = new Map<string, string[]>()
  for (const block of blocks) {
    const own = comparableValue(block)
    if (own === null) {
      continue
    }
    const others = blocks
      .filter((other) => other !== block)
      .filter((other) => {
        const value = comparableValue(other)
        return value !== null && value !== own
      })
      .map((other) => other.hostKey)
    if (others.length > 0) {
      differs.set(block.hostKey, others)
    }
  }
  return differs
}
