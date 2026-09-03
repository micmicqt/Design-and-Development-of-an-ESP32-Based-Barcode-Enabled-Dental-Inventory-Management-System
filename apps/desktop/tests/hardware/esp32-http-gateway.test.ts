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
})
