import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  BluetoothCandidate, DeviceConfigurationSummary, DiscoveredInventoryDevice, SerialPortSummary
} from '../../../shared/ipc-contract'

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void
}

export function DeviceSetupDialog({ open, onClose, onSaved }: Props) {
  const [address, setAddress] = useState('')
  const [token, setToken] = useState('')
  const [configured, setConfigured] = useState<DeviceConfigurationSummary | null>(null)
  const [tokenVisible, setTokenVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ports, setPorts] = useState<SerialPortSummary[]>([])
  const [selectedPort, setSelectedPort] = useState('')
  const [bluetoothCandidates, setBluetoothCandidates] = useState<BluetoothCandidate[]>([])
  const [discovered, setDiscovered] = useState<DiscoveredInventoryDevice | null>(null)
  const [discoveryBusy, setDiscoveryBusy] = useState(false)
  const addressInput = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return undefined
    let active = true
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : null
    setToken('')
    setTokenVisible(false)
    setMessage(null)
    setError(null)
    setConfigured(null)
    setPorts([])
    setSelectedPort('')
    setBluetoothCandidates([])
    setDiscovered(null)
    void window.desktopApi.deviceSetup.getConfiguration().then((result) => {
      if (!active) return
      if (result.ok) {
        setConfigured(result.value)
        setAddress(result.value.address ?? '')
      } else setError(result.error.message)
      addressInput.current?.focus()
    }).catch(() => {
      if (active) setError('Device settings could not be loaded.')
    })
    return () => {
      active = false
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [open])

  if (!open) return null

  function close(): void {
    setToken('')
    setTokenVisible(false)
    onClose()
  }

  async function refreshPorts(): Promise<void> {
    if (discoveryBusy) return
    setDiscoveryBusy(true)
    setError(null)
    try {
      const result = await window.desktopApi.deviceSetup.listSerialPorts()
      if (!result.ok) { setError(result.error.message); return }
      setPorts(result.value)
      setSelectedPort((current) => result.value.some((port) => port.path === current)
        ? current : result.value[0]?.path ?? '')
    } catch { setError('COM ports could not be listed. Check Windows device access.') }
    finally { setDiscoveryBusy(false) }
  }

  async function identifyUsb(): Promise<void> {
    if (discoveryBusy || !selectedPort) return
    setDiscoveryBusy(true)
    setError(null)
    setDiscovered(null)
    try {
      const result = await window.desktopApi.deviceSetup.identifyUsbDevice(selectedPort)
      if (result.ok) setDiscovered(result.value)
      else setError(result.error.message)
    } catch { setError('USB identification did not complete. Please try again.') }
    finally { setDiscoveryBusy(false) }
  }

  async function scanBluetooth(): Promise<void> {
    if (discoveryBusy) return
    setDiscoveryBusy(true)
    setError(null)
    setDiscovered(null)
    setBluetoothCandidates([])
    try {
      const result = await window.desktopApi.deviceSetup.scanBluetooth(setBluetoothCandidates)
      if (result.ok) setDiscovered(result.value)
      else setError(result.error.message)
    } catch { setError('Bluetooth discovery did not complete. Please try again.') }
    finally { setDiscoveryBusy(false); setBluetoothCandidates([]) }
  }

  async function testConnection(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await window.desktopApi.deviceSetup.testConnection(address)
      if (!result.ok) setError(result.error.message)
      else if (result.value.status === 'CONNECTED') {
        setMessage('Connection successful. Inventory Device detected. This test does not validate the token.')
      } else if (result.value.status === 'TIMEOUT') {
        setError('Timeout. The device did not respond. Check its power, network, and address.')
      } else {
        setError('Unable to connect. Check that the device is powered on, on the network, and that the address is correct.')
      }
    } catch {
      setError('Unable to test the connection. Please try again.')
    } finally { setBusy(false) }
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await window.desktopApi.deviceSetup.saveConfiguration(address, token)
      if (!result.ok) { setError(result.error.message); return }
      setConfigured(result.value)
      setToken('')
      onSaved()
      close()
    } catch {
      setError('Device settings could not be saved. Please try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="device-setup-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) close()
    }}>
      <section ref={dialog} className="device-setup-dialog" role="dialog" aria-modal="true"
        aria-labelledby="device-setup-title" onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) close()
          if (event.key === 'Tab') {
            const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled)'
            ) ?? [])
            const first = controls[0]
            const last = controls.at(-1)
            if (first && last && event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last.focus()
            } else if (first && last && !event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first.focus()
            }
          }
        }}>
        <div className="device-setup-dialog__heading">
          <div><p>Inventory Device</p><h2 id="device-setup-title">Device Setup</h2></div>
          <button type="button" className="device-setup-dialog__close" onClick={close}
            disabled={busy} aria-label="Close Device Setup">×</button>
        </div>
        <form onSubmit={(event) => { void save(event) }}>
          <div className="device-setup-dialog__section-title">Primary connection · Wi-Fi</div>
          <label htmlFor="device-address">Device Address</label>
          <input ref={addressInput} id="device-address" type="url" inputMode="url"
            placeholder="http://192.168.1.105" value={address}
            onChange={(event) => { setAddress(event.target.value); setMessage(null) }}
            autoComplete="off" required />
          <p className="device-setup-dialog__hint">Enter the IP address assigned to the Inventory Device on your network.</p>
          <label htmlFor="device-token">Device Token</label>
          <div className="device-setup-dialog__token">
            <input id="device-token" type={tokenVisible ? 'text' : 'password'} value={token}
              onChange={(event) => setToken(event.target.value)} autoComplete="off"
              placeholder={configured?.source === 'saved' && configured.tokenConfigured
                ? 'Token configured — leave blank to keep it' : 'Enter device token'} />
            <button type="button" onClick={() => setTokenVisible((value) => !value)}
              aria-label={tokenVisible ? 'Hide device token' : 'Show device token'}
              title={tokenVisible ? 'Hide device token' : 'Show device token'}>
              {tokenVisible ? 'Hide' : 'Show'}
            </button>
          </div>
          {configured?.source === 'environment' && <p className="device-setup-dialog__hint">
            Current connection uses this computer’s environment settings. Enter a token to save an in-app configuration.
          </p>}
          {error && <p className="device-setup-dialog__error" role="alert">{error}</p>}
          {message && <p className="device-setup-dialog__success" role="status">{message}</p>}
          <div className="device-setup-dialog__actions">
            <button type="button" className="device-setup-dialog__test" disabled={busy || discoveryBusy}
              onClick={() => { void testConnection() }}>Test Connection</button>
            <button type="submit" className="device-setup-dialog__save" disabled={busy || discoveryBusy}>
              {busy ? 'Please wait…' : 'Save'}
            </button>
          </div>
        </form>
        <div className="device-setup-dialog__discovery">
          <h3>Find Inventory Device</h3>
          <p className="device-setup-dialog__hint">USB and Bluetooth only help find the current Wi-Fi address. Inventory still uses Wi-Fi.</p>
          <div className="device-setup-dialog__discovery-group">
            <h4>USB</h4>
            <label htmlFor="device-setup-port">COM Port</label>
            <select id="device-setup-port" value={selectedPort}
              onChange={(event) => setSelectedPort(event.target.value)} disabled={discoveryBusy}>
              {ports.length === 0 && <option value="">No COM ports found</option>}
              {ports.map((port) => <option key={port.path} value={port.path}>
                {port.path}{port.product || port.manufacturer ? ` — ${port.product ?? port.manufacturer}` : ''}
              </option>)}
            </select>
            <div className="device-setup-dialog__discovery-actions">
              <button type="button" onClick={() => { void refreshPorts() }} disabled={discoveryBusy}>Refresh Ports</button>
              <button type="button" onClick={() => { void identifyUsb() }}
                disabled={discoveryBusy || !selectedPort}>Identify Device</button>
            </div>
          </div>
          <div className="device-setup-dialog__discovery-group">
            <h4>Bluetooth</h4>
            <button type="button" onClick={() => { void scanBluetooth() }} disabled={discoveryBusy}>
              Scan for Inventory Device
            </button>
            {bluetoothCandidates.length > 0 && <div className="device-setup-dialog__candidates">
              <p>Select the Inventory Device:</p>
              {bluetoothCandidates.map((candidate) => <button key={candidate.id} type="button"
                onClick={() => { void window.desktopApi.deviceSetup.selectBluetoothDevice(candidate.id) }}>
                {candidate.name}
              </button>)}
            </div>}
          </div>
          {discovered && <div className="device-setup-dialog__found" role="status">
            <strong>Inventory Device found</strong>
            <span>{discovered.name}</span>
            <span>Device ID: {discovered.deviceId}</span>
            <span>Firmware: {discovered.firmware}</span>
            {discovered.ipAddress ? <>
              <span>IP Address: {discovered.ipAddress}</span>
              <button type="button" onClick={() => {
                setAddress(`http://${discovered.ipAddress}`)
                setMessage('Address filled in. Test Connection, then Save when ready.')
              }}>Use This Address</button>
            </> : <span>The device is not currently connected to Wi-Fi.</span>}
          </div>}
        </div>
      </section>
    </div>
  )
}
