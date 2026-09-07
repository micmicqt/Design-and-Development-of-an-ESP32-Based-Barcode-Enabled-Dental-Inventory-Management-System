// @vitest-environment node

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

  beforeEach(() => electronMock.invoke.mockReset())

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

  it('exposes a parameter-free desktop heartbeat on one fixed IPC channel', async () => {
    electronMock.invoke.mockResolvedValueOnce(true)

    await expect(api.hardware.sendDesktopHeartbeat()).resolves.toBe(true)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareSendDesktopHeartbeat
    )

    electronMock.invoke.mockClear()
    const callWithUnexpectedArgument = api.hardware.sendDesktopHeartbeat as (
      unexpected: unknown
    ) => Promise<boolean>
    await callWithUnexpectedArgument('http://untrusted.example/desktop/heartbeat')
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareSendDesktopHeartbeat
    )
  })

  it('exposes a parameter-free next-event invocation and preserves barcode text', async () => {
    const event = {
      eventId: 'device-session-1',
      mode: 'checkout',
      barcode: '00012345',
      timestamp: '2026-09-04 12:00:00'
    }
    electronMock.invoke.mockResolvedValueOnce(event)

    await expect(api.hardware.getNextTransactionEvent()).resolves.toEqual(event)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareGetNextTransactionEvent
    )
  })

  it('preserves a no-event result without fabricating a scan', async () => {
    electronMock.invoke.mockResolvedValueOnce(null)

    await expect(api.hardware.getNextTransactionEvent()).resolves.toBeNull()
  })

  it('forwards only the event ID to the fixed acknowledgement channel', async () => {
    const result = { ok: true, value: { eventId: 'device-session-1' } }
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.acknowledgeTransactionEvent('device-session-1')).resolves.toEqual(result)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareAcknowledgeTransactionEvent,
      'device-session-1'
    )
  })

  it('preserves acknowledgement failure for the renderer to retain the pending event', async () => {
    const result = {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Acknowledgement failed. Try again.' }
    }
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.acknowledgeTransactionEvent('device-session-1')).resolves.toEqual(result)
  })

  it('exposes fixed receipt, processing, result-retry, and ACK-retry channels', async () => {
    const receiptResult = { ok: true, value: null }
    electronMock.invoke.mockResolvedValueOnce(receiptResult)
    await expect(api.hardware.getTransactionReceipt('evt-1')).resolves.toEqual(receiptResult)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.hardwareGetTransactionReceipt,
      'evt-1'
    )

    const processResult = { ok: true, value: { receipt: {}, acknowledged: false } }
    electronMock.invoke.mockResolvedValueOnce(processResult)
    const input = { eventId: 'evt-1', quantity: 2, database: 'untrusted' }
    await expect(api.hardware.processTransaction(input)).resolves.toEqual(processResult)
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.hardwareProcessTransaction,
      { eventId: 'evt-1', quantity: 2 }
    )

    const retryResult = { ok: true, value: { receipt: {}, acknowledged: true } }
    electronMock.invoke.mockResolvedValueOnce(retryResult)
    await expect(api.hardware.retryTransactionResultDelivery('evt-1')).resolves.toEqual(
      retryResult
    )
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.hardwareRetryTransactionResultDelivery,
      'evt-1'
    )

    electronMock.invoke.mockResolvedValueOnce(retryResult)
    await expect(api.hardware.retryTransactionAcknowledgement('evt-1')).resolves.toEqual(
      retryResult
    )
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.hardwareRetryTransactionAcknowledgement,
      'evt-1'
    )
  })

  it('does not forward an extra URL argument for event retrieval', async () => {
    const callWithUnexpectedArgument = api.hardware.getNextTransactionEvent as (
      unexpected: unknown
    ) => Promise<unknown>
    electronMock.invoke.mockResolvedValueOnce(null)

    await callWithUnexpectedArgument('http://untrusted.example/arbitrary')
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareGetNextTransactionEvent
    )
  })

  it('keeps the exposed hardware surface narrow and frozen without network access', () => {
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(api.hardware)).toBe(true)
    expect(Object.keys(api.hardware).sort()).toEqual([
      'acknowledgeTransactionEvent',
      'getNextTransactionEvent',
      'getStatus',
      'getTransactionReceipt',
      'processTransaction',
      'retryTransactionAcknowledgement',
      'retryTransactionResultDelivery',
      'sendDesktopHeartbeat'
    ])
    expect(api.hardware).not.toHaveProperty('baseUrl')
    expect(api.hardware).not.toHaveProperty('fetch')
    expect(api.hardware).not.toHaveProperty('request')
    expect(api.hardware).not.toHaveProperty('invoke')
  })

  it.each(['0012345', ' 0012345 '])(
    'forwards exact barcode text through only the fixed lookup channel: %s',
    async (barcode) => {
      const result = { ok: true, value: null }
      electronMock.invoke.mockResolvedValueOnce(result)

      await expect(api.inventory.findProductByBarcode(barcode)).resolves.toEqual(result)
      expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
        IPC_CHANNELS.productsFindByBarcode,
        barcode
      )
    }
  )

  it('does not expose database queries or generic IPC for barcode lookup', async () => {
    const callWithExtraArgument = api.inventory.findProductByBarcode as (
      barcode: string,
      unexpected: unknown
    ) => Promise<unknown>
    electronMock.invoke.mockResolvedValueOnce({ ok: true, value: null })

    await callWithExtraArgument('00123', { sql: 'SELECT * FROM configured_admin' })
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.productsFindByBarcode,
      '00123'
    )
    expect(Object.isFrozen(api.inventory)).toBe(true)
    expect(api.inventory).not.toHaveProperty('query')
    expect(api.inventory).not.toHaveProperty('execute')
    expect(api.inventory).not.toHaveProperty('database')
    expect(api.inventory).not.toHaveProperty('invoke')
  })

  it('passes barcode lookup errors back without acknowledging a hardware event', async () => {
    const result = {
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Unable to complete the request.' }
    }
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.inventory.findProductByBarcode('00123')).resolves.toEqual(result)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.productsFindByBarcode,
      '00123'
    )
  })
})
