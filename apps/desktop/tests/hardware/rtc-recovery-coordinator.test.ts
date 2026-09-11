// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type {
  HardwareStatusGateway,
  RtcSynchronizationGateway
} from '../../src/main/hardware/hardware-gateway'
import { createRtcRecoveryCoordinator } from '../../src/main/hardware/rtc-recovery-coordinator'
import {
  Esp32HttpGateway,
  type HardwareFetch,
  type HardwareHttpResponse
} from '../../src/main/hardware/esp32-http-gateway'

const hostTimeMs = Date.UTC(2026, 8, 10, 12, 30, 45)

function status(rtcState: 'ready' | 'needs_sync' | 'unavailable') {
  return {
    device: 'dental-inventory-esp32' as const,
    online: true,
    mode: 'idle' as const,
    rtc: rtcState === 'ready',
    rtcState,
    rtcReason: rtcState === 'ready'
      ? 'none' as const
      : rtcState === 'needs_sync'
        ? 'lost_power' as const
        : 'communication_failure' as const,
    sd: true
  }
}

function gatewayWithState(rtcState: 'ready' | 'needs_sync' | 'unavailable') {
  return {
    healthCheck: vi.fn(),
    getStatus: vi.fn().mockResolvedValue(status(rtcState)),
    sendDesktopHeartbeat: vi.fn(),
    synchronizeRtc: vi.fn().mockResolvedValue({
      synchronized: true,
      rtcState: 'ready',
      alreadyReady: false
    })
  } satisfies HardwareStatusGateway & RtcSynchronizationGateway
}

function createLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

function jsonResponse(value: unknown): HardwareHttpResponse {
  return { ok: true, status: 200, json: vi.fn().mockResolvedValue(value) }
}

describe('deployment-safe RTC recovery coordinator', () => {
  it('automatically synchronizes a needs-sync RTC from Electron main system time', async () => {
    const gateway = gatewayWithState('needs_sync')
    const logger = createLogger()
    const coordinator = createRtcRecoveryCoordinator({
      gateway, now: () => hostTimeMs, logger
    })

    await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('SYNCHRONIZED')
    expect(gateway.synchronizeRtc).toHaveBeenCalledExactlyOnceWith({
      epochSeconds: Math.floor(hostTimeMs / 1_000),
      utcOffsetMinutes: -new Date(hostTimeMs).getTimezoneOffset()
    })
    expect(logger.info.mock.calls.map(([message]) => message)).toEqual([
      '[RTC recovery] trigger observed: NEEDS_SYNC',
      '[RTC recovery] attempt started',
      '[RTC recovery] succeeded'
    ])
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each(['ready', 'unavailable'] as const)(
    'does not rewrite an RTC whose state is %s',
    async (rtcState) => {
      const gateway = gatewayWithState(rtcState)
      const logger = createLogger()
      const coordinator = createRtcRecoveryCoordinator({
        gateway, now: () => hostTimeMs, logger
      })

      await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('NOT_REQUIRED')
      await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('NOT_REQUIRED')
      expect(gateway.synchronizeRtc).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledTimes(1)
    }
  )

  it('backs off after failure and retries safely without a heartbeat write loop', async () => {
    let currentTimeMs = hostTimeMs
    const gateway = gatewayWithState('needs_sync')
    const logger = createLogger()
    gateway.synchronizeRtc
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValueOnce({ synchronized: true, rtcState: 'ready', alreadyReady: false })
    const coordinator = createRtcRecoveryCoordinator({
      gateway,
      now: () => currentTimeMs,
      retryBackoffMs: 12_000,
      logger
    })

    await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('FAILED')
    currentTimeMs += 4_000
    await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('RETRY_DEFERRED')
    currentTimeMs += 8_000
    await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('SYNCHRONIZED')
    expect(gateway.synchronizeRtc).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      '[RTC recovery] sync request failed: UNKNOWN_FAILURE'
    )
    expect(logger.info).toHaveBeenCalledWith('[RTC recovery] skipped: RETRY_BACKOFF')
  })

  it('shares an in-flight recovery attempt instead of issuing overlapping writes', async () => {
    let resolveStatus: ((value: ReturnType<typeof status>) => void) | undefined
    const gateway = gatewayWithState('needs_sync')
    const logger = createLogger()
    gateway.getStatus.mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve
    }))
    const coordinator = createRtcRecoveryCoordinator({
      gateway, now: () => hostTimeMs, logger
    })

    const first = coordinator.synchronizeIfNeeded()
    const second = coordinator.synchronizeIfNeeded()
    expect(first).toBe(second)
    expect(gateway.getStatus).toHaveBeenCalledOnce()
    resolveStatus?.(status('needs_sync'))
    await expect(first).resolves.toBe('SYNCHRONIZED')
    expect(gateway.synchronizeRtc).toHaveBeenCalledOnce()
  })

  it('reports the real pre-transport token failure instead of silently skipping POST', async () => {
    const fetcher = vi.fn<HardwareFetch>().mockResolvedValue(jsonResponse(status('needs_sync')))
    const gateway = new Esp32HttpGateway({ baseUrl: 'http://esp32.test', fetcher })
    const logger = createLogger()
    const coordinator = createRtcRecoveryCoordinator({
      gateway, now: () => hostTimeMs, logger
    })

    await expect(coordinator.synchronizeIfNeeded()).resolves.toBe('FAILED')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      'http://esp32.test/status', expect.objectContaining({ method: 'GET' })
    )
    expect(logger.error).toHaveBeenCalledWith(
      '[RTC recovery] sync request failed: DEVICE_TOKEN_UNCONFIGURED'
    )
  })
})
