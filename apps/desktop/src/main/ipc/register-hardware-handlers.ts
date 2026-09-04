import { ipcMain } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import {
  isValidHardwareTransactionEventId,
  type HardwareTransactionEventGateway
} from '../hardware/hardware-gateway'
import {
  IPC_CHANNELS,
  type HardwareStatusDto,
  type HardwareTransactionEvent,
  type IpcResult
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'

export interface RegisterHardwareIpcHandlersOptions {
  gateway: HardwareTransactionEventGateway | null
  authSession: AuthSessionController
  getMainWindow: MainWindowProvider
}

function offlineStatus(): HardwareStatusDto {
  return {
    connection: 'OFFLINE',
    device: null,
    mode: null,
    rtc: null,
    sd: null
  }
}

export function registerHardwareIpcHandlers(
  options: RegisterHardwareIpcHandlersOptions
): () => void {
  const { gateway, authSession, getMainWindow } = options

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetStatus,
    async (event): Promise<HardwareStatusDto> => {
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated() ||
        gateway === null
      ) {
        return offlineStatus()
      }

      try {
        const status = await gateway.getStatus()
        return {
          connection: status.online ? 'CONNECTED' : 'OFFLINE',
          device: status.device,
          mode: status.mode,
          rtc: status.rtc,
          sd: status.sd
        }
      } catch {
        return offlineStatus()
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareGetNextTransactionEvent,
    async (event): Promise<HardwareTransactionEvent | null> => {
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated() ||
        gateway === null
      ) {
        return null
      }

      try {
        return await gateway.getNextTransactionEvent()
      } catch {
        // Offline/malformed responses must not crash the inventory workspace.
        // No event is acknowledged here; the next poll can safely retry.
        return null
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.hardwareAcknowledgeTransactionEvent,
    async (event, eventId: unknown): Promise<IpcResult<{ eventId: string }>> => {
      if (
        !isTrustedMainFrame(event, getMainWindow) ||
        !authSession.isAuthenticated()
      ) {
        return {
          ok: false,
          error: { code: 'UNAUTHORIZED', message: 'Please sign in to dismiss hardware scans.' }
        }
      }

      if (!isValidHardwareTransactionEventId(eventId)) {
        return {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'The transaction event ID is invalid.' }
        }
      }

      try {
        if (gateway === null) throw new Error('Hardware is not configured.')
        await gateway.acknowledgeTransactionEvent(eventId)
        return { ok: true, value: { eventId } }
      } catch {
        return {
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Unable to acknowledge this scan. Check the ESP32 connection and retry.'
          }
        }
      }
    }
  )

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetStatus)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetNextTransactionEvent)
    ipcMain.removeHandler(IPC_CHANNELS.hardwareAcknowledgeTransactionEvent)
  }
}
