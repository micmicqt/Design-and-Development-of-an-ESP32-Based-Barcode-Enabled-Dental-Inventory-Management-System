import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import {
  DeviceConfigurationError,
  validateDeviceAddress,
  type DeviceConfiguration,
  type DeviceConfigurationStore
} from '../hardware/device-configuration-store'
import { Esp32HttpGateway, HardwareGatewayError } from '../hardware/esp32-http-gateway'
import { identifyUsbDevice, listUsbSerialPorts, UsbDiscoveryError } from '../hardware/usb-device-discovery'
import {
  IPC_CHANNELS,
  type DiscoveredInventoryDevice,
  type DeviceConfigurationSummary,
  type DeviceConnectionTest,
  type IpcResult,
  type SerialPortSummary
} from '../../shared/ipc-contract'
import { isTrustedMainFrame, type MainWindowProvider } from './ipc-security'

interface Options {
  store: DeviceConfigurationStore
  authSession: AuthSessionController
  getMainWindow: MainWindowProvider
  activate: (configuration: DeviceConfiguration) => void
  canActivate?: () => boolean
  createGateway?: (address: string) => Pick<Esp32HttpGateway, 'healthCheck'>
  listSerialPorts?: typeof listUsbSerialPorts
  identifyUsb?: typeof identifyUsbDevice
  selectBluetooth?: (id: unknown) => boolean
}

function authorized(event: IpcMainInvokeEvent, options: Options): boolean {
  return isTrustedMainFrame(event, options.getMainWindow) && options.authSession.isAuthenticated()
}

function configurationFailure(error: unknown): IpcResult<never> {
  if (error instanceof DeviceConfigurationError) {
    return { ok: false, error: {
      code: error.code === 'INVALID_ADDRESS' || error.code === 'INVALID_TOKEN'
        ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      message: error.code === 'INVALID_ADDRESS'
        ? 'Enter a valid http:// or https:// device address without a path.'
        : error.code === 'INVALID_TOKEN'
          ? 'Enter a valid device token (32–128 characters).'
          : error.code === 'SECURE_STORAGE_UNAVAILABLE'
            ? 'Secure Windows storage is unavailable. Device settings were not saved.'
            : 'Device settings could not be saved. Please try again.'
    } }
  }
  return { ok: false, error: {
    code: 'INTERNAL_ERROR', message: 'Device setup is unavailable. Please try again.'
  } }
}

export function registerDeviceSetupIpcHandlers(options: Options): () => void {
  ipcMain.handle(IPC_CHANNELS.deviceSetupGet,
    (event): IpcResult<DeviceConfigurationSummary> => {
      if (!authorized(event, options)) return { ok: false, error: {
        code: 'UNAUTHORIZED', message: 'Administrator authentication is required.'
      } }
      return { ok: true, value: options.store.resolve().summary }
    })

  ipcMain.handle(IPC_CHANNELS.deviceSetupTest,
    async (event, rawAddress: unknown): Promise<IpcResult<DeviceConnectionTest>> => {
      if (!authorized(event, options)) return { ok: false, error: {
        code: 'UNAUTHORIZED', message: 'Administrator authentication is required.'
      } }
      let address: string
      try {
        address = validateDeviceAddress(rawAddress)
      } catch (error: unknown) {
        return configurationFailure(error)
      }
      try {
        const gateway = options.createGateway?.(address) ??
          new Esp32HttpGateway({ baseUrl: address })
        await gateway.healthCheck()
        return { ok: true, value: { status: 'CONNECTED' } }
      } catch (error: unknown) {
        return { ok: true, value: {
          status: error instanceof HardwareGatewayError &&
            error.diagnosticCode === 'REQUEST_TIMEOUT' ? 'TIMEOUT' : 'UNAVAILABLE'
        } }
      }
    })

  ipcMain.handle(IPC_CHANNELS.deviceSetupSave,
    (event, rawInput: unknown): IpcResult<DeviceConfigurationSummary> => {
      if (!authorized(event, options)) return { ok: false, error: {
        code: 'UNAUTHORIZED', message: 'Administrator authentication is required.'
      } }
      if (typeof rawInput !== 'object' || rawInput === null ||
          Object.keys(rawInput).sort().join(',') !== 'address,token') {
        return configurationFailure(new DeviceConfigurationError('INVALID_ADDRESS'))
      }
      const input = rawInput as Record<string, unknown>
      if (options.canActivate?.() === false) {
        return { ok: false, error: { code: 'VALIDATION_ERROR',
          message: 'Finish the current hardware operation before changing Device Setup.' } }
      }
      try {
        const configuration = options.store.save(input.address, input.token)
        options.activate(configuration)
        return { ok: true, value: options.store.resolve().summary }
      } catch (error: unknown) {
        return configurationFailure(error)
      }
    })

  ipcMain.handle(IPC_CHANNELS.deviceSetupListSerialPorts,
    async (event): Promise<IpcResult<SerialPortSummary[]>> => {
      if (!authorized(event, options)) return { ok: false, error: {
        code: 'UNAUTHORIZED', message: 'Administrator authentication is required.'
      } }
      try { return { ok: true, value: await (options.listSerialPorts ?? listUsbSerialPorts)() } }
      catch { return { ok: false, error: {
        code: 'INTERNAL_ERROR', message: 'COM ports could not be listed. Check Windows device access.'
      } } }
    })

  ipcMain.handle(IPC_CHANNELS.deviceSetupIdentifyUsb,
    async (event, port: unknown): Promise<IpcResult<DiscoveredInventoryDevice>> => {
      if (!authorized(event, options)) return { ok: false, error: {
        code: 'UNAUTHORIZED', message: 'Administrator authentication is required.'
      } }
      if (typeof port !== 'string' || !/^COM[1-9]\d{0,2}$/i.test(port)) return {
        ok: false, error: { code: 'VALIDATION_ERROR', message: 'Select a valid COM port.' }
      }
      try { return { ok: true, value: await (options.identifyUsb ?? identifyUsbDevice)(port) } }
      catch (error) {
        const reason = error instanceof UsbDiscoveryError ? error.reason : 'OPEN'
        const message = reason === 'PORT' ? 'The selected COM port is no longer available.'
          : reason === 'TIMEOUT' ? 'The device did not answer. Check the USB cable and try again.'
            : reason === 'INVALID' ? 'That COM port did not return a valid Inventory Device identity.'
              : reason === 'DISCONNECTED' ? 'The COM port disconnected during identification.'
                : 'The COM port could not be opened. Close any serial monitor using it.'
        return { ok: false, error: { code: 'DEVICE_DISCOVERY_FAILED', message } }
      }
    })

  ipcMain.handle(IPC_CHANNELS.deviceSetupSelectBluetooth,
    (event, id: unknown): boolean => authorized(event, options) &&
      (options.selectBluetooth?.(id) ?? false))

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.deviceSetupGet)
    ipcMain.removeHandler(IPC_CHANNELS.deviceSetupTest)
    ipcMain.removeHandler(IPC_CHANNELS.deviceSetupSave)
    ipcMain.removeHandler(IPC_CHANNELS.deviceSetupListSerialPorts)
    ipcMain.removeHandler(IPC_CHANNELS.deviceSetupIdentifyUsb)
    ipcMain.removeHandler(IPC_CHANNELS.deviceSetupSelectBluetooth)
  }
}
