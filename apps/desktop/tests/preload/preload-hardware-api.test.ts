// @vitest-environment node

import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../src/shared/ipc-contract'
import { IPC_CHANNELS } from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  getPathForFile: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: { invoke: electronMock.invoke },
  webUtils: { getPathForFile: electronMock.getPathForFile }
}))

describe('preload hardware API', () => {
  let api: DesktopApi

  beforeAll(async () => {
    await import('../../src/preload/index')
    const exposure = electronMock.exposeInMainWorld.mock.calls.find(
      ([name]) => name === 'desktopApi'
    )
    if (exposure === undefined) throw new Error('desktopApi was not exposed by preload.')
    api = exposure[1] as DesktopApi
  })

  it('exposes only a parameter-free hardware status invocation', async () => {
    const expected = {
      connection: 'CONNECTED',
      device: 'dental-inventory-esp32',
      mode: 'idle',
      rtc: true,
      sd: true
    }
    electronMock.invoke.mockResolvedValueOnce(expected)

    await expect(api.hardware.getStatus()).resolves.toEqual(expected)
    expect(electronMock.invoke).toHaveBeenCalledWith(IPC_CHANNELS.hardwareGetStatus)
  })
})
