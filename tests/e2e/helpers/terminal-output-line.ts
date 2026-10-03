const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
// CSI (colours, cursor), OSC (titles, ended by BEL or ST) and charset selection.
const TERMINAL_ESCAPE_SEQUENCE = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[()][0-9A-Za-z]`,
  'g'
)

/** True when some rendered line is exactly the marker, i.e. the command's OUTPUT, not its echo. */
export function terminalHasOutputLine(serialized: string, marker: string): boolean {
  return serialized
    .replace(TERMINAL_ESCAPE_SEQUENCE, '')
    .split(/\r?\n/)
    .some((line) => line.trim() === marker)
}
