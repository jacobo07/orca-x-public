import type { BacklogChatGptImportAnswer } from '../../shared/backlog-harvest-report'

/** Desktop-only backlog surface; takes no argument, so the renderer can never name a file. */
export type BacklogDesktopApi = {
  importChatGptExport: () => Promise<BacklogChatGptImportAnswer>
}
