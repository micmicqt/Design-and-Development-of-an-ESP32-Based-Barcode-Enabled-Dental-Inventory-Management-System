import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

export type MainWindowProvider = () => BrowserWindow | null

export function isTrustedMainFrame(
  event: IpcMainInvokeEvent,
  getMainWindow: MainWindowProvider
): boolean {
  const window = getMainWindow()
  if (window === null || window.isDestroyed() || event.sender.isDestroyed()) return false

  return event.sender === window.webContents && event.senderFrame === event.sender.mainFrame
}
