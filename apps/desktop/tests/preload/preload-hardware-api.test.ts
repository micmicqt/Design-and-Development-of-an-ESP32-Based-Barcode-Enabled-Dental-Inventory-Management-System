// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../src/shared/ipc-contract'
import { IPC_CHANNELS } from '../../src/shared/ipc-contract'

const electronMock = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  getPathForFile: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: { invoke: electronMock.invoke, on: electronMock.on,
    removeListener: electronMock.removeListener },
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
  afterEach(() => vi.unstubAllGlobals())

  it('exposes only narrow device setup IPC and no filesystem or secret getter', async () => {
    electronMock.invoke.mockResolvedValue({ ok: true })
    await api.deviceSetup.getConfiguration()
    await api.deviceSetup.testConnection('http://device')
    await api.deviceSetup.saveConfiguration('http://device', 'replacement-token')
    await api.deviceSetup.listSerialPorts()
    await api.deviceSetup.identifyUsbDevice('COM5')
    await api.deviceSetup.selectBluetoothDevice('selected-id')
    expect(electronMock.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.deviceSetupGet],
      [IPC_CHANNELS.deviceSetupTest, 'http://device'],
      [IPC_CHANNELS.deviceSetupSave, { address: 'http://device', token: 'replacement-token' }],
      [IPC_CHANNELS.deviceSetupListSerialPorts],
      [IPC_CHANNELS.deviceSetupIdentifyUsb, 'COM5'],
      [IPC_CHANNELS.deviceSetupSelectBluetooth, 'selected-id']
    ])
    expect(Object.isFrozen(api.deviceSetup)).toBe(true)
    expect(api.deviceSetup).not.toHaveProperty('decrypt')
    expect(api.deviceSetup).not.toHaveProperty('readFile')
  })

  it('reads only the fixed BLE discovery characteristic and disconnects afterward', async () => {
    const disconnect = vi.fn()
    const readValue = vi.fn().mockResolvedValue(new DataView(new TextEncoder().encode(
      '@ATD:DEVICE:1:ATD-1234ABCD:1:192.168.1.105:0.1.0'
    ).buffer))
    const getCharacteristic = vi.fn().mockResolvedValue({ readValue })
    const getPrimaryService = vi.fn().mockResolvedValue({ getCharacteristic })
    const requestDevice = vi.fn().mockResolvedValue({ gatt: {
      connect: vi.fn().mockResolvedValue({ getPrimaryService }), disconnect
    } })
    vi.stubGlobal('navigator', { bluetooth: { requestDevice } })
    const onCandidates = vi.fn()
    await expect(api.deviceSetup.scanBluetooth(onCandidates)).resolves.toMatchObject({
      ok: true, value: { deviceId: 'ATD-1234ABCD', ipAddress: '192.168.1.105' }
    })
    expect(requestDevice).toHaveBeenCalledWith({ filters: [{ services: [
      '4e6a1000-8eab-4c73-9c6e-1f749d86a0d1'
    ] }] })
    expect(getPrimaryService).toHaveBeenCalledWith('4e6a1000-8eab-4c73-9c6e-1f749d86a0d1')
    expect(getCharacteristic).toHaveBeenCalledWith('4e6a1001-8eab-4c73-9c6e-1f749d86a0d1')
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('exposes only fixed first-run administrator IPC channels', async () => {
    electronMock.invoke.mockResolvedValueOnce(true)
    await expect(api.auth.needsSetup()).resolves.toBe(true)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.authGetSetupState)

    electronMock.invoke.mockClear()
    electronMock.invoke.mockResolvedValueOnce({ ok: true })
    await expect(api.auth.createFirstAdmin({
      username: 'clinic-admin', password: 'a secure clinic password'
    })).resolves.toEqual({ ok: true })
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.authCreateFirstAdmin,
      { username: 'clinic-admin', password: 'a secure clinic password' }
    )
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

  it('exposes registration capture only through its fixed parameter-free channel', async () => {
    const result = { ok: true, value: { barcode: '000012340056' } }
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.captureRegistrationBarcode()).resolves.toEqual(result)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareCaptureRegistrationBarcode
    )

    electronMock.invoke.mockClear()
    const callWithUnexpectedArgument = api.hardware.captureRegistrationBarcode as (
      unexpected: unknown
    ) => Promise<unknown>
    await callWithUnexpectedArgument({ url: 'http://untrusted.example', mode: 'checkout' })
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareCaptureRegistrationBarcode
    )
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

  it('exposes parameter-free offline retrieval on one fixed IPC channel', async () => {
    const event = {
      eventId: 'off-20500DE58C14-0000000000000001',
      timestamp: '2026-09-04 08:30:00',
      productId: '7',
      barcode: '0000000000000123',
      action: 'CHECKOUT',
      delta: -1,
      resultingStock: 2,
      stockStatus: 'LOW',
      cacheGeneration: `v1-${'a'.repeat(64)}`
    } as const
    const result = { ok: true, value: event } as const
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.getNextOfflineEvent()).resolves.toEqual(result)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareGetNextOfflineEvent
    )

    electronMock.invoke.mockClear()
    electronMock.invoke.mockResolvedValueOnce({ ok: true, value: null })
    const callWithUnexpectedArguments = api.hardware.getNextOfflineEvent as (
      url: unknown,
      method: unknown,
      payload: unknown
    ) => Promise<unknown>
    await callWithUnexpectedArguments(
      'http://untrusted.example/offline/events/next',
      'DELETE',
      { eventId: event.eventId }
    )
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareGetNextOfflineEvent
    )
  })

  it('passes offline retrieval failures through without fabricating an empty journal', async () => {
    const result = {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unable to read pending offline transactions. Check the ESP32 and retry.'
      }
    } as const
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.getNextOfflineEvent()).resolves.toEqual(result)
  })

  it('exposes parameter-free offline reconciliation on one fixed IPC channel', async () => {
    const result = {
      ok: true,
      value: {
        status: 'APPLIED',
        receipt: {
          eventId: 'off-20500DE58C14-0000000000000001',
          transactionId: 'movement-1',
          productId: 7,
          barcode: '0000000000000123',
          itemName: 'Cleanser',
          category: 'General',
          action: 'CHECKOUT',
          delta: -1,
          previousStock: 3,
          newTotal: 2,
          status: 'LOW',
          offlineResultingStock: 2,
          offlineStockStatus: 'LOW',
          timestamp: '2026-09-04 08:30:00',
          cacheGeneration: `v1-${'a'.repeat(64)}`
        }
      }
    } as const
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.reconcileNextOfflineEvent()).resolves.toEqual(result)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareReconcileNextOfflineEvent
    )

    electronMock.invoke.mockClear()
    electronMock.invoke.mockResolvedValueOnce({
      ok: true,
      value: { status: 'NO_PENDING_EVENT' }
    })
    const callWithUnexpectedArguments = api.hardware.reconcileNextOfflineEvent as (
      event: unknown,
      totals: unknown,
      request: unknown
    ) => Promise<unknown>
    await callWithUnexpectedArguments(
      { eventId: 'forged-offline-event' },
      { previousStock: 900, newTotal: 901 },
      { url: 'http://untrusted.example', method: 'DELETE', sql: 'DROP TABLE products' }
    )
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareReconcileNextOfflineEvent
    )
  })

  it('exposes parameter-free offline synchronization without forwarding backend data', async () => {
    const result = {
      ok: true,
      value: {
        status: 'COMPLETE',
        counts: {
          appliedEvents: 2,
          alreadyAppliedEvents: 1,
          acknowledgedEvents: 3
        },
        pendingSyncItems: 0,
        cache: {
          generation: `v1-${'a'.repeat(64)}`,
          itemCount: 8,
          alreadyCurrent: false
        }
      }
    } as const
    electronMock.invoke.mockResolvedValueOnce(result)

    await expect(api.hardware.synchronizeOfflineInventory()).resolves.toEqual(result)
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareSynchronizeOfflineInventory
    )

    electronMock.invoke.mockClear()
    electronMock.invoke.mockResolvedValueOnce(result)
    const callWithUnexpectedArguments = api.hardware.synchronizeOfflineInventory as (
      event: unknown,
      url: unknown,
      stocks: unknown
    ) => Promise<unknown>
    await callWithUnexpectedArguments(
      { eventId: 'off-FORGED' },
      'http://untrusted.example/offline/events/ack',
      [{ id: 7, currentStock: 999_999 }]
    )
    expect(electronMock.invoke).toHaveBeenCalledExactlyOnceWith(
      IPC_CHANNELS.hardwareSynchronizeOfflineInventory
    )
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
      'captureRegistrationBarcode',
      'getNextOfflineEvent',
      'getNextTransactionEvent',
      'getStatus',
      'getTransactionReceipt',
      'processTransaction',
      'reconcileNextOfflineEvent',
      'retryTransactionAcknowledgement',
      'retryTransactionResultDelivery',
      'sendDesktopHeartbeat',
      'synchronizeOfflineInventory'
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
