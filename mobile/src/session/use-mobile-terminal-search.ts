import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TerminalSearchResults,
  TerminalWebViewHandle
} from '../terminal/terminal-webview-contract'
import { formatTerminalSearchCount } from './mobile-terminal-search-count'

type Params = {
  activeHandle: string | null
  // The active tab is a terminal whose WebView can answer.
  canSearch: boolean
  getTerminalRef: (handle: string | null) => TerminalWebViewHandle | undefined
}

/** Find-in-scrollback for the active terminal; bound to the handle it was opened on. */
export function useMobileTerminalSearch({ activeHandle, canSearch, getTerminalRef }: Params) {
  const [openHandle, setOpenHandle] = useState<string | null>(null)
  const [query, setQueryState] = useState('')
  const [results, setResults] = useState<TerminalSearchResults | null>(null)
  const openHandleRef = useRef<string | null>(null)
  const queryRef = useRef('')

  const close = useCallback(() => {
    getTerminalRef(openHandleRef.current)?.clearSearch()
    openHandleRef.current = null
    queryRef.current = ''
    setOpenHandle(null)
    setQueryState('')
    setResults(null)
  }, [getTerminalRef])

  const open = useCallback(() => {
    if (!canSearch || !activeHandle) {
      return
    }
    openHandleRef.current = activeHandle
    setOpenHandle(activeHandle)
    setResults(null)
  }, [activeHandle, canSearch])

  const setQuery = useCallback(
    (next: string) => {
      queryRef.current = next
      setQueryState(next)
      if (!next) {
        setResults(null)
      }
      getTerminalRef(openHandleRef.current)?.search(next, 'next')
    },
    [getTerminalRef]
  )

  const step = useCallback(
    (direction: 'next' | 'previous') => {
      if (queryRef.current) {
        getTerminalRef(openHandleRef.current)?.search(queryRef.current, direction)
      }
    },
    [getTerminalRef]
  )

  // Why: highlights belong to one terminal; switching tabs or losing it ends the search.
  useEffect(() => {
    if (openHandle && (openHandle !== activeHandle || !canSearch)) {
      close()
    }
  }, [activeHandle, canSearch, close, openHandle])

  const handleSearchResults = useCallback((handle: string, next: TerminalSearchResults) => {
    if (handle === openHandleRef.current && queryRef.current) {
      setResults(next)
    }
  }, [])

  return {
    isOpen: openHandle !== null,
    query,
    countLabel: formatTerminalSearchCount(query, results),
    hasMatches: (results?.resultCount ?? 0) > 0,
    open,
    close,
    setQuery,
    next: () => step('next'),
    previous: () => step('previous'),
    handleSearchResults
  }
}
