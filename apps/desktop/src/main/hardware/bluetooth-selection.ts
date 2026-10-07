import type { BrowserWindow } from 'electron'
import type { AuthSessionController } from '../application/auth-session'
import type { BluetoothCandidate } from '../../shared/ipc-contract'

const CANDIDATE_CHANNEL = 'device-setup:bluetooth-candidates'
const DISCOVERY_PREFIX = 'AnyTimeDental-Inventory'

export function createBluetoothSelectionController(authSession: AuthSessionController) {
  let pending: { callback: (id: string) => void; candidates: BluetoothCandidate[];
    timer: ReturnType<typeof setTimeout> } | null = null

  const cancel = (): void => {
    if (!pending) return
    clearTimeout(pending.timer)
    pending.callback('')
    pending = null
  }

  return {
    attach(window: BrowserWindow): void {
      window.webContents.on('select-bluetooth-device', (event, devices, callback) => {
        event.preventDefault()
        if (!authSession.isAuthenticated()) { callback(''); return }
        const candidates = devices.filter((device) => device.deviceName.startsWith(DISCOVERY_PREFIX))
          .map((device) => ({ id: device.deviceId, name: device.deviceName }))
        if (!pending) {
          pending = { callback, candidates, timer: setTimeout(cancel, 20000) }
        } else {
          pending.callback = callback
          pending.candidates = candidates
        }
        window.webContents.send(CANDIDATE_CHANNEL, candidates)
      })
      window.on('closed', cancel)
    },
    select(id: unknown): boolean {
      if (!authSession.isAuthenticated() || !pending || typeof id !== 'string' ||
          (id !== '' && !pending.candidates.some((candidate) => candidate.id === id))) return false
      const selected = pending
      pending = null
      clearTimeout(selected.timer)
      selected.callback(id)
      return true
    },
    cancel
  }
}

export { CANDIDATE_CHANNEL }
