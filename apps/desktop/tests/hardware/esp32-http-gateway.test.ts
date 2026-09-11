// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Esp32HttpGateway,
  type HardwareFetch,
  type HardwareGatewayError,
  type HardwareHttpResponse
} from '../../src/main/hardware/esp32-http-gateway'

function jsonResponse(value: unknown, status = 200): HardwareHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(value)
  }
}

const transactionEvent = {
  eventId: '20500de58c14-0123456789abcdef0123456789abcdef-1',
  mode: 'restock',
  barcode: '0004806016001569',
  timestamp: '2026-09-04 12:34:56'
} as const

const transactionResult = {
  eventId: transactionEvent.eventId,
  result: 'success',
  mode: 'restock',
  quantity: 2,
  resultingStock: 22,
  stockStatus: 'HIGH'
} as const

const cacheGeneration = `v1-${'a'.repeat(64)}`
const offlinePendingEvent = {
  eventId: 'off-20500DE58C14-0000000000000001',
  timestamp: '2026-09-04 12:34:56',
  productId: '7',
  barcode: '0004806016001569',
  action: 'RESTOCK',
  delta: 1,
  resultingStock: 22,
  stockStatus: 'HIGH',
  cacheGeneration
} as const
const cacheProducts = [
  {
    id: '7',
    barcode: '0004806016001569',
    name: 'Cleanser',
    category: 'General',
    currentStock: 20,
    lowStockThreshold: 5,
    status: 'HIGH'
  },
  {
    id: '8',
    barcode: '00000002',
    name: 'Composite Resin',
    category: 'Restorative & Esthetic',
    currentStock: 0,
    lowStockThreshold: 3,
    status: 'EMPTY'
  }
] as const

function cacheResponse(
  operation: 'begin' | 'item' | 'commit',
  receivedItems: number,
  alreadyCurrent = false
) {
  return {
    accepted: true,
    operation,
    generation: cacheGeneration,
    receivedItems,
    alreadyCurrent
  }
}

describe('ESP32 HTTP hardware gateway', () => {
  afterEach(() => vi.useRealTimers())

  it('parses and validates the health response', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({ status: 'ok', device: 'dental-inventory-esp32', phase: 4 })
    )
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://192.0.2.10/',
      fetcher
    })

    await expect(gateway.healthCheck()).resolves.toEqual({
      status: 'ok',
      device: 'dental-inventory-esp32',
      phase: 4
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://192.0.2.10/health',
      expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } })
    )
  })

  it('parses and validates the device status response', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'checkout',
        rtc: true,
        sd: false
      })
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).resolves.toEqual({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'checkout',
      rtc: true,
      sd: false
    })
    expect(fetcher).toHaveBeenCalledWith(
      'http://esp32.local/status',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('distinguishes RTC ready, needs-sync, and unavailable status from legacy rtc compatibility', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: false,
        rtcState: 'needs_sync', rtcReason: 'lost_power', sd: true
      }))
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: false,
        rtcState: 'unavailable', rtcReason: 'communication_failure', sd: true
      }))
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: true,
        rtcState: 'ready', rtcReason: 'none', sd: true
      }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).resolves.toMatchObject({
      rtc: false, rtcState: 'needs_sync', rtcReason: 'lost_power'
    })
    await expect(gateway.getStatus()).resolves.toMatchObject({
      rtc: false, rtcState: 'unavailable', rtcReason: 'communication_failure'
    })
    await expect(gateway.getStatus()).resolves.toMatchObject({
      rtc: true, rtcState: 'ready', rtcReason: 'none'
    })
  })

  it.each([
    { rtc: true, rtcState: 'needs_sync', rtcReason: 'lost_power' },
    { rtc: false, rtcState: 'ready', rtcReason: 'none' },
    { rtc: false, rtcState: 'needs_sync', rtcReason: 'none' },
    { rtc: false, rtcState: 'unknown', rtcReason: 'lost_power' },
    { rtc: false, rtcState: 'needs_sync' },
    { rtc: false, rtcReason: 'lost_power' }
  ])('rejects inconsistent RTC status metadata %#', async (rtcMetadata) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({
      device: 'dental-inventory-esp32', online: true, mode: 'idle', sd: true,
      ...rtcMetadata
    }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts the optional desktop-presence field without requiring it from older firmware', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true
      }))
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true,
        desktopOnline: false
      }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).resolves.not.toHaveProperty('desktopOnline')
    await expect(gateway.getStatus()).resolves.toMatchObject({ desktopOnline: false })
  })

  it('rejects a malformed optional desktop-presence field', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true,
      desktopOnline: 'yes'
    }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts typed optional offline-cache metadata while preserving legacy status', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true,
      desktopOnline: true,
      offlineCacheAvailable: true,
      offlineCacheGeneration: cacheGeneration,
      offlineCacheItems: 2
    }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).resolves.toMatchObject({
      offlineCacheAvailable: true,
      offlineCacheGeneration: cacheGeneration,
      offlineCacheItems: 2
    })
  })

  it.each([
    { offlineCacheAvailable: true },
    { offlineCacheAvailable: 'yes', offlineCacheGeneration: cacheGeneration, offlineCacheItems: 2 },
    { offlineCacheAvailable: true, offlineCacheGeneration: 'latest', offlineCacheItems: 2 },
    { offlineCacheAvailable: true, offlineCacheGeneration: null, offlineCacheItems: 2 },
    { offlineCacheAvailable: true, offlineCacheGeneration: cacheGeneration, offlineCacheItems: 10_001 },
    { offlineCacheAvailable: false, offlineCacheGeneration: cacheGeneration, offlineCacheItems: 2 },
    { offlineCacheAvailable: false, offlineCacheGeneration: null, offlineCacheItems: 1 }
  ])('rejects malformed optional offline-cache metadata %#', async (cacheMetadata) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true,
      ...cacheMetadata
    }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('accepts bounded optional offline-journal status while preserving older firmware', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true
      }))
      .mockResolvedValueOnce(jsonResponse({
        device: 'dental-inventory-esp32',
        online: true,
        mode: 'idle',
        rtc: true,
        sd: true,
        offlineCacheAvailable: true,
        offlineCacheGeneration: cacheGeneration,
        offlineCacheItems: 2,
        pendingSyncItems: 10_000,
        offlineReady: true
      }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).resolves.not.toHaveProperty('pendingSyncItems')
    await expect(gateway.getStatus()).resolves.toMatchObject({
      pendingSyncItems: 10_000,
      offlineReady: true
    })
  })

  it.each([
    { pendingSyncItems: 3 },
    { offlineReady: true },
    { pendingSyncItems: -1 },
    { pendingSyncItems: 1.5 },
    { pendingSyncItems: 10_001 },
    { pendingSyncItems: '3' },
    { pendingSyncItems: null },
    { offlineReady: 'yes' },
    { offlineReady: 1 },
    { offlineReady: null }
  ])('rejects malformed optional offline-journal status %#', async (metadata) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({
      device: 'dental-inventory-esp32',
      online: true,
      mode: 'idle',
      rtc: true,
      sd: true,
      ...metadata
    }))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.getStatus()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('posts a desktop heartbeat through only the fixed endpoint', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({ desktopOnline: true })
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.sendDesktopHeartbeat()).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'http://192.0.2.10/desktop/heartbeat',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' }
      })
    )
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })

  it('authenticates only the fixed RTC synchronization route with the backend token', async () => {
    const deviceToken = 'a'.repeat(64)
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse({ desktopOnline: true }))
      .mockResolvedValueOnce(jsonResponse({
        synchronized: true,
        rtcState: 'ready',
        alreadyReady: false
      }))
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://192.0.2.10',
      deviceToken,
      fetcher
    })

    await gateway.sendDesktopHeartbeat()
    await expect(gateway.synchronizeRtc({
      epochSeconds: 1_789_065_600,
      utcOffsetMinutes: 480
    })).resolves.toEqual({
      synchronized: true,
      rtcState: 'ready',
      alreadyReady: false
    })

    expect(fetcher.mock.calls[0]?.[1].headers).not.toHaveProperty('X-Device-Token')
    expect(fetcher.mock.calls[1]).toEqual([
      'http://192.0.2.10/rtc/sync',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Device-Token': deviceToken
        },
        body: JSON.stringify({
          epochSeconds: 1_789_065_600,
          utcOffsetMinutes: 480
        })
      })
    ])
  })

  it('fails closed without a device token and never sends an RTC request', async () => {
    const fetcher = vi.fn<HardwareFetch>()
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.synchronizeRtc({
      epochSeconds: 1_789_065_600,
      utcOffsetMinutes: 480
    })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      diagnosticCode: 'DEVICE_TOKEN_UNCONFIGURED'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('preserves only an allow-listed RTC firmware failure category', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({ synchronized: false, error: 'unauthorized', token: 'never-forward' }, 401)
    )
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://esp32.local', deviceToken: 'a'.repeat(64), fetcher
    })

    await expect(gateway.synchronizeRtc({
      epochSeconds: 1_789_065_600,
      utcOffsetMinutes: 480
    })).rejects.toMatchObject({ code: 'REJECTED', diagnosticCode: 'unauthorized' })
  })

  it.each([
    { epochSeconds: 0, utcOffsetMinutes: 480 },
    { epochSeconds: 1_789_065_600.5, utcOffsetMinutes: 480 },
    { epochSeconds: 1_789_065_600, utcOffsetMinutes: 841 },
    { epochSeconds: Number.NaN, utcOffsetMinutes: 480 }
  ])('rejects an invalid host RTC request before transport %#', async (request) => {
    const fetcher = vi.fn<HardwareFetch>()
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://esp32.local', deviceToken: 'a'.repeat(64), fetcher
    })

    await expect(gateway.synchronizeRtc(request)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { desktopOnline: false },
    { desktopOnline: 'true' },
    { desktopOnline: true, credentials: 'leak' }
  ])('rejects an invalid desktop-heartbeat response %#', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.sendDesktopHeartbeat()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it('reports desktop-heartbeat network failure without implicit retries', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockRejectedValue(new Error('network unavailable'))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.sendDesktopHeartbeat()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('installs an offline cache through bounded begin, item, and commit requests', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse(cacheResponse('begin', 0)))
      .mockResolvedValueOnce(jsonResponse(cacheResponse('item', 1)))
      .mockResolvedValueOnce(jsonResponse(cacheResponse('item', 2)))
      .mockResolvedValueOnce(jsonResponse(cacheResponse('commit', 2)))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts
    })).resolves.toEqual({
      generation: cacheGeneration,
      itemCount: 2,
      alreadyCurrent: false
    })

    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body ?? '')).toEqual({
      operation: 'begin', generation: cacheGeneration, itemCount: 2
    })
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body ?? '')).toEqual({
      operation: 'item', generation: cacheGeneration, index: 0, product: cacheProducts[0]
    })
    expect(JSON.parse(fetcher.mock.calls[2]?.[1].body ?? '')).toEqual({
      operation: 'item', generation: cacheGeneration, index: 1, product: cacheProducts[1]
    })
    expect(JSON.parse(fetcher.mock.calls[3]?.[1].body ?? '')).toEqual({
      operation: 'commit', generation: cacheGeneration, itemCount: 2
    })
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe('http://esp32.local/offline/cache')
      expect(options.method).toBe('POST')
    }
  })

  it('rejects a non-current begin response that claims a trusted staged prefix', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValueOnce(
      jsonResponse(cacheResponse('begin', 1))
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('treats an already-current generation as success without sending items or commit', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse(cacheResponse('begin', 2, true))
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts
    })).resolves.toEqual({
      generation: cacheGeneration,
      itemCount: 2,
      alreadyCurrent: true
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('safely installs an empty active inventory with no item request', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse(cacheResponse('begin', 0)))
      .mockResolvedValueOnce(jsonResponse(cacheResponse('commit', 0)))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: []
    })).resolves.toMatchObject({ itemCount: 0 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed cache snapshots before making an HTTP request', async () => {
    const fetcher = vi.fn<HardwareFetch>()
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: 'not-a-generation',
      products: cacheProducts
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: [{ ...cacheProducts[0], barcode: 123 }]
    } as never)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: [{ ...cacheProducts[0], status: 'LOW' }]
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: [{ ...cacheProducts[0], unexpected: true }]
    } as never)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts,
      unexpected: true
    } as never)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects inconsistent cache progress without sending a later item or commit', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockResolvedValueOnce(jsonResponse(cacheResponse('begin', 0)))
      .mockResolvedValueOnce(jsonResponse(cacheResponse('item', 0)))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects cache responses with untracked contract fields', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValueOnce(
      jsonResponse({ ...cacheResponse('begin', 0), diagnostic: 'unexpected' })
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('reports a pending-offline-journal cache interlock as a retryable rejection', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({}, 409))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.local', fetcher })

    await expect(gateway.installOfflineInventoryCache({
      generation: cacheGeneration,
      products: cacheProducts
    })).rejects.toMatchObject({ code: 'REJECTED' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    { status: 'ok', device: 'unexpected-device', phase: 4 },
    { status: 'ok', device: 'dental-inventory-esp32', phase: '4' },
    { device: 'dental-inventory-esp32', online: true, mode: 'unknown', rtc: true, sd: true },
    { device: 'dental-inventory-esp32', online: true, mode: 'idle', rtc: 'yes', sd: true }
  ])('rejects malformed or unexpected payloads', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.168.1.100', fetcher })
    const request = 'status' in payload ? gateway.healthCheck() : gateway.getStatus()

    await expect(request).rejects.toMatchObject<Partial<HardwareGatewayError>>({
      code: 'INVALID_RESPONSE'
    })
  })

  it('aborts a request that exceeds the configured timeout', async () => {
    vi.useFakeTimers()
    const fetcher: HardwareFetch = (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://192.168.1.100',
      requestTimeoutMs: 25,
      fetcher
    })

    const expectation = expect(gateway.getStatus()).rejects.toMatchObject<
      Partial<HardwareGatewayError>
    >({
      code: 'UNAVAILABLE'
    })
    await vi.advanceTimersByTimeAsync(25)
    await expectation
  })

  it('maps non-success HTTP responses to unavailable', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({}, 503))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.168.1.100', fetcher })

    await expect(gateway.healthCheck()).rejects.toMatchObject<Partial<HardwareGatewayError>>({
      code: 'UNAVAILABLE'
    })
  })

  it.each(['restock', 'checkout'] as const)(
    'retrieves a %s event without converting barcode text or acknowledging it',
    async (mode) => {
      const expected = { ...transactionEvent, mode }
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(expected))
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(gateway.getNextTransactionEvent()).resolves.toEqual(expected)
      await expect(gateway.getNextTransactionEvent()).resolves.toEqual(expected)
      expect(fetcher).toHaveBeenCalledTimes(2)
      for (const call of fetcher.mock.calls) {
        expect(call).toEqual([
          'http://192.0.2.10/events/next',
          expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } })
        ])
      }
    }
  )

  it.each([' 0000123 ', 'A'.repeat(256), 'ABC-001/2:"\\'])(
    'preserves firmware-accepted barcode text exactly: %s',
    async (barcode) => {
      const expected = { ...transactionEvent, barcode }
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(expected))
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(gateway.getNextTransactionEvent()).resolves.toEqual(expected)
    }
  )

  it('treats only HTTP 204 as an empty queue without parsing JSON', async () => {
    const response = jsonResponse(undefined, 204)
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(response)
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextTransactionEvent()).resolves.toBeNull()
    expect(response.json).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    {},
    { ...transactionEvent, barcode: 4806016001569 },
    { ...transactionEvent, barcode: '' },
    { ...transactionEvent, barcode: '   ' },
    { ...transactionEvent, barcode: 'A'.repeat(257) },
    { ...transactionEvent, barcode: 'abc,123' },
    { ...transactionEvent, barcode: 'é123' },
    { ...transactionEvent, barcode: 'abc\r\n' },
    { ...transactionEvent, barcode: 'abc\u0000' },
    { ...transactionEvent, barcode: 'abc\u007f' },
    { ...transactionEvent, mode: 'RESTOCK' },
    { ...transactionEvent, mode: 'idle' },
    { ...transactionEvent, mode: null },
    { ...transactionEvent, eventId: '' },
    { ...transactionEvent, eventId: 'A'.repeat(64) },
    { ...transactionEvent, eventId: 'event id' },
    { ...transactionEvent, eventId: '../event' },
    { ...transactionEvent, eventId: 1 },
    { ...transactionEvent, timestamp: '2026-09-04T12:34:56Z' },
    { ...transactionEvent, timestamp: '2026-02-29 12:34:56' },
    { ...transactionEvent, timestamp: '2026-04-31 12:34:56' },
    { ...transactionEvent, timestamp: '1999-09-04 12:34:56' },
    { ...transactionEvent, timestamp: '2100-09-04 12:34:56' },
    { ...transactionEvent, timestamp: '2026-00-04 12:34:56' },
    { ...transactionEvent, timestamp: '2026-09-00 12:34:56' },
    { ...transactionEvent, timestamp: '2026-09-04 24:34:56' },
    { ...transactionEvent, timestamp: '2026-09-04 12:60:56' },
    { ...transactionEvent, timestamp: '2026-09-04 12:34:60' },
    { ...transactionEvent, timestamp: null },
    { ...transactionEvent, quantity: 1 }
  ])('rejects malformed or out-of-scope event payload %#', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextTransactionEvent()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it('accepts a valid leap-day RTC timestamp', async () => {
    const expected = { ...transactionEvent, timestamp: '2028-02-29 00:00:00' }
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(expected))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextTransactionEvent()).resolves.toEqual(expected)
  })

  it('retrieves the same oldest offline event repeatedly without changing its exact fields', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(offlinePendingEvent))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextOfflineEvent()).resolves.toEqual(offlinePendingEvent)
    await expect(gateway.getNextOfflineEvent()).resolves.toEqual(offlinePendingEvent)
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const call of fetcher.mock.calls) {
      expect(call).toEqual([
        'http://192.0.2.10/offline/events/next',
        expect.objectContaining({ method: 'GET', headers: { Accept: 'application/json' } })
      ])
      expect(call[1]).not.toHaveProperty('body')
    }
  })

  it('keeps the authoritative offline-head read fixed despite unexpected call arguments', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(offlinePendingEvent))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(
      Reflect.apply(gateway.getNextOfflineEvent, gateway, [
        'http://untrusted.example/offline/events/delete',
        'DELETE',
        { eventId: offlinePendingEvent.eventId, resultingStock: 999_999 }
      ])
    ).resolves.toEqual(offlinePendingEvent)

    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'http://192.0.2.10/offline/events/next',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
    )
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })

  it.each(['0000000000000001', ' 0000001 '])(
    'preserves exact offline barcode text: %s',
    async (barcode) => {
      const expected = { ...offlinePendingEvent, barcode }
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(expected))
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(gateway.getNextOfflineEvent()).resolves.toEqual(expected)
    }
  )

  it('maps only HTTP 204 to no pending offline event without parsing a body', async () => {
    const response = jsonResponse(undefined, 204)
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(response)
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextOfflineEvent()).resolves.toBeNull()
    expect(response.json).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    {},
    { ...offlinePendingEvent, eventId: '' },
    { ...offlinePendingEvent, eventId: transactionEvent.eventId },
    { ...offlinePendingEvent, eventId: 'off-20500de58c14-0000000000000001' },
    { ...offlinePendingEvent, eventId: 'off-20500DE58C14-0000000000000000' },
    { ...offlinePendingEvent, eventId: 1 },
    { ...offlinePendingEvent, timestamp: '2026-09-04T12:34:56Z' },
    { ...offlinePendingEvent, productId: '' },
    { ...offlinePendingEvent, productId: '0' },
    { ...offlinePendingEvent, productId: '007' },
    { ...offlinePendingEvent, productId: '1'.repeat(32) },
    { ...offlinePendingEvent, productId: 7 },
    { ...offlinePendingEvent, barcode: 4806016001569 },
    { ...offlinePendingEvent, barcode: 'abc,123' },
    { ...offlinePendingEvent, action: 'checkout' },
    { ...offlinePendingEvent, action: 'DELETE' },
    { ...offlinePendingEvent, action: 'RESTOCK', delta: -1 },
    { ...offlinePendingEvent, action: 'CHECKOUT', delta: 1 },
    { ...offlinePendingEvent, delta: 0 },
    { ...offlinePendingEvent, delta: 1.5 },
    { ...offlinePendingEvent, resultingStock: -1 },
    { ...offlinePendingEvent, resultingStock: 1.5 },
    { ...offlinePendingEvent, resultingStock: Number.MAX_SAFE_INTEGER + 1 },
    { ...offlinePendingEvent, resultingStock: 0, stockStatus: 'HIGH' },
    { ...offlinePendingEvent, resultingStock: 1, stockStatus: 'EMPTY' },
    { ...offlinePendingEvent, stockStatus: 'UNKNOWN' },
    { ...offlinePendingEvent, cacheGeneration: 'latest' },
    { ...offlinePendingEvent, unexpected: true }
  ])('rejects a malformed offline event as an explicit protocol error %#', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextOfflineEvent()).rejects.toMatchObject<
      Partial<HardwareGatewayError>
    >({ code: 'INVALID_RESPONSE' })
  })

  it.each([201, 202, 206])(
    'rejects HTTP %s as an unexpected offline-event success status',
    async (status) => {
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
        jsonResponse(offlinePendingEvent, status)
      )
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(gateway.getNextOfflineEvent()).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
  )

  it('rejects malformed offline-event JSON as an explicit protocol error', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('Invalid JSON'))
    })
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextOfflineEvent()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it('keeps offline-event network failure retryable without implicit retries', async () => {
    const fetcher = vi.fn<HardwareFetch>()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValueOnce(jsonResponse(offlinePendingEvent))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextOfflineEvent()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(gateway.getNextOfflineEvent()).resolves.toEqual(offlinePendingEvent)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('aborts a stalled offline-event request as retryable unavailability', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<HardwareFetch>().mockImplementation((_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    )
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://192.0.2.10',
      requestTimeoutMs: 25,
      fetcher
    })
    const expectation = expect(gateway.getNextOfflineEvent()).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    })

    await vi.advanceTimersByTimeAsync(25)
    await expectation
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('posts exactly one offline event ID and validates the complete ACK receipt', async () => {
    const acknowledgement = {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 3,
      alreadyAcknowledged: false
    } as const
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(acknowledgement))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)).resolves.toEqual(
      acknowledgement
    )
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'http://192.0.2.10/offline/events/ack',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: offlinePendingEvent.eventId })
      })
    )
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body ?? '{}')).toEqual({
      eventId: offlinePendingEvent.eventId
    })
  })

  it('allows the real SD-backed ACK latency beyond the lightweight request timeout', async () => {
    vi.useFakeTimers()
    const acknowledgement = {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 5,
      alreadyAcknowledged: false
    } as const
    const fetcher = vi.fn<HardwareFetch>().mockImplementation(
      (_url, options) =>
        new Promise((resolve, reject) => {
          const completion = setTimeout(() => resolve(jsonResponse(acknowledgement)), 3_000)
          options.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(completion)
              reject(new Error('aborted'))
            },
            { once: true }
          )
        })
    )
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://192.0.2.10',
      requestTimeoutMs: 2_500,
      fetcher
    })

    const acknowledgementRequest = gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(acknowledgementRequest).resolves.toEqual(acknowledgement)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([0, 10_000])(
    'accepts bounded pending count %s on an idempotent offline ACK receipt',
    async (pendingSyncItems) => {
      const acknowledgement = {
        acknowledged: true,
        eventId: offlinePendingEvent.eventId,
        pendingSyncItems,
        alreadyAcknowledged: true
      } as const
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(acknowledgement))
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(
        gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
      ).resolves.toEqual(acknowledgement)
    }
  )

  it.each([
    '',
    transactionEvent.eventId,
    'off-20500de58c14-0000000000000001',
    'off-20500DE58C14-0000000000000000',
    'off-20500DE58C14-0000000000000001/next'
  ])('rejects invalid outgoing offline ACK IDs before HTTP: %s', async (eventId) => {
    const fetcher = vi.fn<HardwareFetch>()
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.acknowledgeOfflineEvent(eventId)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    {
      acknowledged: false,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 0,
      alreadyAcknowledged: false
    },
    {
      acknowledged: true,
      eventId: 'off-20500DE58C14-0000000000000002',
      pendingSyncItems: 0,
      alreadyAcknowledged: false
    },
    {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: -1,
      alreadyAcknowledged: false
    },
    {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 1.5,
      alreadyAcknowledged: false
    },
    {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 10_001,
      alreadyAcknowledged: false
    },
    {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 0,
      alreadyAcknowledged: 'false'
    },
    {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 0
    },
    {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 0,
      alreadyAcknowledged: true,
      resultingStock: 999
    }
  ])('rejects a malformed offline ACK receipt %#', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(
      gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each([400, 404, 409])(
    'reports HTTP %s offline ACK refusal as REJECTED with bounded safe diagnostics',
    async (status) => {
      const response = jsonResponse({ error: 'ack refused' }, status)
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(response)
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(
        gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
      ).rejects.toMatchObject({ code: 'REJECTED' })
      expect(response.json).toHaveBeenCalledOnce()
    }
  )

  it('preserves the firmware journal failure code without exposing a raw response', async () => {
    const fetcher = vi
      .fn<HardwareFetch>()
      .mockResolvedValue(jsonResponse({ acknowledged: false, error: 'pending_journal_invalid' }, 500))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(
      gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      diagnosticCode: 'pending_journal_invalid'
    })
  })

  it.each([201, 202, 204, 206])(
    'rejects HTTP %s as an unexpected offline ACK success status',
    async (status) => {
      const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
        jsonResponse({
          acknowledged: true,
          eventId: offlinePendingEvent.eventId,
          pendingSyncItems: 0,
          alreadyAcknowledged: false
        }, status)
      )
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(
        gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  )

  it('keeps offline ACK network failure retryable without an implicit retry', async () => {
    const acknowledgement = {
      acknowledged: true,
      eventId: offlinePendingEvent.eventId,
      pendingSyncItems: 0,
      alreadyAcknowledged: true
    } as const
    const fetcher = vi.fn<HardwareFetch>()
      .mockRejectedValueOnce(new Error('network failed after ACK'))
      .mockResolvedValueOnce(jsonResponse(acknowledgement))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(
      gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(
      gateway.acknowledgeOfflineEvent(offlinePendingEvent.eventId)
    ).resolves.toEqual(acknowledgement)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('posts the complete committed result and accepts an explicit matching response', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({ accepted: true, eventId: transactionEvent.eventId })
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.deliverTransactionResult(transactionResult)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'http://192.0.2.10/events/result',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(transactionResult)
      })
    )
  })

  it.each([
    { ...transactionResult, eventId: 'invalid/id' },
    { ...transactionResult, result: 'failed' },
    { ...transactionResult, mode: 'RESTOCK' },
    { ...transactionResult, quantity: 0 },
    { ...transactionResult, quantity: 1.5 },
    { ...transactionResult, quantity: 10_001 },
    { ...transactionResult, resultingStock: -1 },
    { ...transactionResult, resultingStock: 1.5 },
    { ...transactionResult, stockStatus: 'UNKNOWN' }
  ])('rejects an invalid outgoing transaction result before HTTP %#', async (result) => {
    const fetcher = vi.fn<HardwareFetch>()
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(
      gateway.deliverTransactionResult(result as typeof transactionResult)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { accepted: false, eventId: transactionEvent.eventId },
    { accepted: 'true', eventId: transactionEvent.eventId },
    { accepted: true, eventId: 'different-event' },
    { accepted: true },
    { accepted: true, eventId: transactionEvent.eventId, duplicate: false }
  ])('rejects an invalid result-acceptance body %#', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.deliverTransactionResult(transactionResult)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it.each([400, 404, 409])('reports HTTP %s result refusal as REJECTED', async (status) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({}, status))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.deliverTransactionResult(transactionResult)).rejects.toMatchObject({
      code: 'REJECTED'
    })
  })

  it('posts exactly the event ID and accepts the explicit matching ACK', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({ acknowledged: true, eventId: transactionEvent.eventId })
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.acknowledgeTransactionEvent(transactionEvent.eventId)).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'http://192.0.2.10/events/ack',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: transactionEvent.eventId })
      })
    )
  })

  it.each(['', ' event', 'event id', '../event', 'A'.repeat(64)])(
    'rejects invalid outgoing ACK IDs before HTTP: %s',
    async (eventId) => {
      const fetcher = vi.fn<HardwareFetch>()
      const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

      await expect(gateway.acknowledgeTransactionEvent(eventId)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each([
    null,
    {},
    { acknowledged: false, eventId: transactionEvent.eventId },
    { acknowledged: 'true', eventId: transactionEvent.eventId },
    { acknowledged: true, eventId: 'different-event' },
    { acknowledged: true },
    { eventId: transactionEvent.eventId },
    { acknowledged: true, eventId: transactionEvent.eventId, quantity: 1 }
  ])('rejects an invalid acknowledgement body %#', async (payload) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(payload))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.acknowledgeTransactionEvent(transactionEvent.eventId)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it.each([400, 404, 409])('reports HTTP %s ACK refusal as REJECTED', async (status) => {
    const response = jsonResponse({ error: 'ack refused' }, status)
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(response)
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.acknowledgeTransactionEvent(transactionEvent.eventId)).rejects.toMatchObject({
      code: 'REJECTED'
    })
    expect(response.json).not.toHaveBeenCalled()
  })

  it.each([201, 202, 206])('rejects HTTP %s as an unexpected event success status', async (status) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(transactionEvent, status))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.getNextTransactionEvent()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it.each([201, 202, 204, 206])('rejects HTTP %s as an unexpected ACK success status', async (status) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(
      jsonResponse({ acknowledged: true, eventId: transactionEvent.eventId }, status)
    )
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    await expect(gateway.acknowledgeTransactionEvent(transactionEvent.eventId)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })

  it.each(['next', 'ack'] as const)('reports malformed JSON for %s', async (operation) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('Invalid JSON'))
    })
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    const request = operation === 'next'
      ? gateway.getNextTransactionEvent()
      : gateway.acknowledgeTransactionEvent(transactionEvent.eventId)
    await expect(request).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each(['next', 'ack'] as const)('handles network loss for %s', async (operation) => {
    const fetcher = vi.fn<HardwareFetch>().mockRejectedValue(new Error('network failed'))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    const request = operation === 'next'
      ? gateway.getNextTransactionEvent()
      : gateway.acknowledgeTransactionEvent(transactionEvent.eventId)
    await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each(['next', 'ack'] as const)('handles an HTTP server failure for %s', async (operation) => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse({}, 503))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://192.0.2.10', fetcher })

    const request = operation === 'next'
      ? gateway.getNextTransactionEvent()
      : gateway.acknowledgeTransactionEvent(transactionEvent.eventId)
    await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it.each(['next', 'ack'] as const)('aborts a stalled %s request without retrying implicitly', async (operation) => {
    vi.useFakeTimers()
    const fetcher = vi.fn<HardwareFetch>().mockImplementation((_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    )
    const gateway = new Esp32HttpGateway({
      baseUrl: 'http://192.0.2.10',
      requestTimeoutMs: 25,
      fetcher
    })
    const request = operation === 'next'
      ? gateway.getNextTransactionEvent()
      : gateway.acknowledgeTransactionEvent(transactionEvent.eventId)
    const expectation = expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' })

    await vi.advanceTimersByTimeAsync(25)
    await expectation
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
