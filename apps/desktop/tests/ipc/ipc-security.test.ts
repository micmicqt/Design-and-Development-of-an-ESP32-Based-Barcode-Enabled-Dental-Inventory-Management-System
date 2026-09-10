// @vitest-environment node

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { isTrustedMainFrame } from '../../src/main/ipc/ipc-security'

function createBoundary() {
  const mainFrame = {}
  const webContents = {
    isDestroyed: () => false,
    mainFrame
  }
  const mainWindow = {
    isDestroyed: () => false,
    webContents
  } as unknown as BrowserWindow
  const event = {
    sender: webContents,
    senderFrame: mainFrame
  } as unknown as IpcMainInvokeEvent

  return { event, mainFrame, mainWindow, webContents }
}

describe('main-window IPC trust boundary', () => {
  it('trusts only the exact live main-frame sender', () => {
    const { event, mainWindow } = createBoundary()

    expect(isTrustedMainFrame(event, () => mainWindow)).toBe(true)
  })

  it('rejects missing or destroyed window and sender state', () => {
    const { event, mainWindow, mainFrame } = createBoundary()

    expect(isTrustedMainFrame(event, () => null)).toBe(false)
    expect(
      isTrustedMainFrame(event, () => ({
        isDestroyed: () => true,
        webContents: event.sender
      }) as unknown as BrowserWindow)
    ).toBe(false)
    expect(
      isTrustedMainFrame({
        ...event,
        sender: { isDestroyed: () => true, mainFrame }
      } as unknown as IpcMainInvokeEvent, () => mainWindow)
    ).toBe(false)
  })

  it('rejects another webContents and every subframe', () => {
    const { event, mainWindow } = createBoundary()
    const otherMainFrame = {}

    expect(
      isTrustedMainFrame({
        ...event,
        sender: { isDestroyed: () => false, mainFrame: otherMainFrame },
        senderFrame: otherMainFrame
      } as unknown as IpcMainInvokeEvent, () => mainWindow)
    ).toBe(false)
    expect(
      isTrustedMainFrame({
        ...event,
        senderFrame: {}
      } as unknown as IpcMainInvokeEvent, () => mainWindow)
    ).toBe(false)
  })
})
