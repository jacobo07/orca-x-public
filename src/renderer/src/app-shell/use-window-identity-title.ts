import { useEffect } from 'react'
import { PRODUCT_NAME } from '../../../shared/product'
import { buildWindowIdentityTitle } from '../../../shared/window-identity-title'
import { useActiveRepo, useActiveWorktree } from '../store/selectors'

/**
 * Names this window after the project it owns.
 *
 * Why `document.title` rather than an IPC call to `BrowserWindow.setTitle`: every workspace window
 * is its own renderer with its own document, so writing the title here is window-scoped by
 * construction — no sender plumbing, no per-window title cache in main to go stale, and a reload
 * re-derives it from the store the window rehydrates. Electron promotes the document title to the
 * native window title, which is what Alt-Tab and the taskbar read.
 */
export function useWindowIdentityTitle(): void {
  const repo = useActiveRepo()
  const worktree = useActiveWorktree()

  const title = buildWindowIdentityTitle(
    {
      projectName: repo?.displayName ?? null,
      worktreeName: worktree?.displayName ?? null
    },
    PRODUCT_NAME
  )

  useEffect(() => {
    document.title = title
  }, [title])
}
