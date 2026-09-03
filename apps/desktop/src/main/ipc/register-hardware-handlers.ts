import { ipcMain } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import type { HardwareStatusGateway } from '../hardware/hardware-gateway'
import {
  IPC_CHANNELS,
  type HardwareStatusDto
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'

export interface RegisterHardwareIpcHandlersOptions {
  gateway: HardwareStatusGateway | null
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

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.hardwareGetStatus)
  }
}
