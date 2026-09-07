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
