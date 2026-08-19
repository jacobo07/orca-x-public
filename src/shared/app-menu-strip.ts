/** A top-level entry of the registered application menu, as the titlebar strip renders it. */
export type MenuTopLevelItem = {
  /** Index into the registered menu's items — how the strip asks for this exact submenu back. */
  index: number
  label: string
  enabled: boolean
}

/** Where to open a menu. Omitting the index pops the whole application menu, which is what the
 *  ··· button has always done; omitting the coordinates lets Electron place it at the cursor. */
export type MenuPopupRequest = {
  topLevelIndex?: number
  x?: number
  y?: number
}
