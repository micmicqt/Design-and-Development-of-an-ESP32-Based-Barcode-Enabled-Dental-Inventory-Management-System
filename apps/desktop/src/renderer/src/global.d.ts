import type { DesktopApi } from '../../shared/ipc-contract'

declare global {
  interface Window {
    desktopApi: DesktopApi
  }
}

export {}
