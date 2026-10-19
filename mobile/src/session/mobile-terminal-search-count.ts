import type { TerminalSearchResults } from '../terminal/terminal-webview-contract'

/** The search bar's count: '' until there is a query and an answer, then n/m, 0/0, or m alone. */
export function formatTerminalSearchCount(
  query: string,
  results: TerminalSearchResults | null
): string {
  if (query.length === 0 || !results) {
    return ''
  }
  if (results.resultCount === 0) {
    return '0/0'
  }
  if (results.resultIndex < 0) {
    return String(results.resultCount)
  }
  return `${results.resultIndex + 1}/${results.resultCount}`
}
