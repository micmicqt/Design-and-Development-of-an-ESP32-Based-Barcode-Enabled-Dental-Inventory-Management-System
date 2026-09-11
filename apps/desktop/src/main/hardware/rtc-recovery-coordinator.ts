import type {
  HardwareStatusGateway,
  RtcSynchronizationGateway,
  RtcSynchronizationRequest
} from './hardware-gateway'
import { HardwareGatewayError } from './esp32-http-gateway'

const DEFAULT_RETRY_BACKOFF_MS = 12_000

export type RtcRecoveryOutcome =
  | 'NOT_REQUIRED'
  | 'SYNCHRONIZED'
  | 'RETRY_DEFERRED'
  | 'FAILED'

export interface RtcRecoveryCoordinator {
  synchronizeIfNeeded(): Promise<RtcRecoveryOutcome>
}

export interface RtcRecoveryCoordinatorOptions {
  gateway: HardwareStatusGateway & RtcSynchronizationGateway
  now?: () => number
  retryBackoffMs?: number
  logger?: Pick<Console, 'info' | 'error'>
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof HardwareGatewayError) {
    return error.diagnosticCode ?? error.code
  }
  return 'UNKNOWN_FAILURE'
}

export function createRtcRecoveryCoordinator(
  options: RtcRecoveryCoordinatorOptions
): RtcRecoveryCoordinator {
  const now = options.now ?? Date.now
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS
  const logger = options.logger ?? console
  if (!Number.isSafeInteger(retryBackoffMs) || retryBackoffMs <= 0) {
    throw new Error('RTC recovery retry backoff must be a positive integer.')
  }

  let nextAttemptAtMs = 0
  let activeAttempt: Promise<RtcRecoveryOutcome> | null = null
  let lastSkipDiagnostic: string | null = null

  function reportSkip(reason: string): void {
    if (lastSkipDiagnostic === reason) return
    lastSkipDiagnostic = reason
    logger.info(`[RTC recovery] skipped: ${reason}`)
  }

  async function run(): Promise<RtcRecoveryOutcome> {
    const attemptTimeMs = now()
    if (!Number.isFinite(attemptTimeMs) || attemptTimeMs < 0) {
      logger.error('[RTC recovery] sync request failed: INVALID_HOST_CLOCK')
      return 'FAILED'
    }
    if (attemptTimeMs < nextAttemptAtMs) {
      reportSkip('RETRY_BACKOFF')
      return 'RETRY_DEFERRED'
    }

    try {
      const status = await options.gateway.getStatus()
      if (status.rtcState !== 'needs_sync') {
        nextAttemptAtMs = 0
        reportSkip(
          status.rtcState === 'ready'
            ? 'RTC_READY'
            : status.rtcState === 'unavailable'
              ? 'RTC_HARDWARE_UNAVAILABLE'
              : 'RTC_STATE_NOT_REPORTED'
        )
        return 'NOT_REQUIRED'
      }

      lastSkipDiagnostic = null
      logger.info('[RTC recovery] trigger observed: NEEDS_SYNC')
      logger.info('[RTC recovery] attempt started')
      const hostTime = new Date(attemptTimeMs)
      const request: RtcSynchronizationRequest = {
        epochSeconds: Math.floor(attemptTimeMs / 1_000),
        utcOffsetMinutes: -hostTime.getTimezoneOffset()
      }
      await options.gateway.synchronizeRtc(request)
      nextAttemptAtMs = 0
      logger.info('[RTC recovery] succeeded')
      return 'SYNCHRONIZED'
    } catch (error: unknown) {
      nextAttemptAtMs = attemptTimeMs + retryBackoffMs
      logger.error(`[RTC recovery] sync request failed: ${safeFailureCategory(error)}`)
      return 'FAILED'
    }
  }

  return {
    synchronizeIfNeeded(): Promise<RtcRecoveryOutcome> {
      if (activeAttempt !== null) return activeAttempt
      const attempt = run()
      activeAttempt = attempt
      void attempt.finally(() => {
        if (activeAttempt === attempt) activeAttempt = null
      })
      return attempt
    }
  }
}
