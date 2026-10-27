// Why: shared so the CLI's logon task builder and main's lock-held exit read one literal; the CLI cannot import src/main.
export const SERVE_AUTOSTART_FLAG = '--serve-autostart'
