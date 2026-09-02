/**
 * Which local PTYs a renderer reload is allowed to sweep.
 *
 * The sweep's original question was "is this PTY from an older page load?", answered by a
 * process-wide generation counter. That was a complete answer while there was one page. With more
 * than one workspace window the counter still advances globally, so a reload in window B marks
 * window A's terminals as belonging to an older load — which they do, and which means nothing.
 *
 * The question that survives a second window is "does a live renderer still own this?".
 */
export function shouldSparePtyFromOrphanSweep(args: {
  ptyId: string
  /** The renderer whose reload triggered the sweep. */
  reloadingWebContentsId: number
  ownerWebContentsIdFor: (ptyId: string) => number | null
  isRendererAlive: (webContentsId: number) => boolean
}): boolean {
  const ownerWebContentsId = args.ownerWebContentsIdFor(args.ptyId)
  if (ownerWebContentsId === null || ownerWebContentsId === args.reloadingWebContentsId) {
    return false
  }
  // A dead owner is not a reason to keep the process alive: no window will reclaim it, and sparing
  // it would leak a shell for the rest of the session.
  return args.isRendererAlive(ownerWebContentsId)
}
