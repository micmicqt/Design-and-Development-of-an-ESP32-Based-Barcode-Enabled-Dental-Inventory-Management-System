import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type {
  AuthSession,
  HardwareMode,
  HardwareStatusDto,
  HardwareTransactionEvent,
  HardwareTransactionReceipt
} from '../../shared/ipc-contract'
import clinicLogo from './assets/branding/any-time-dental-logo.png'
import staffPhotoOne from './assets/branding/staff-01.jpg'
import staffPhotoTwo from './assets/branding/staff-02.jpg'
import staffPhotoThree from './assets/branding/staff-03.jpg'
import { HardwareTransactionDialog } from './components/HardwareTransactionDialog'
import { DeviceSetupDialog } from './components/DeviceSetupDialog'
import { AddItemPage } from './pages/AddItemPage'
import { InventoryPage } from './pages/InventoryPage'
import { MovementHistoryPage } from './pages/MovementHistoryPage'
import { SyncOfflinePage } from './pages/SyncOfflinePage'

const NAVIGATION_ITEMS = [
  'ITEM INVENTORY',
  'MOVEMENT HISTORY',
  'ADD NEW ITEM',
  'SYNC OFFLINE'
] as const

type NavigationItem = (typeof NAVIGATION_ITEMS)[number]

const EMPTY_SESSION: AuthSession = { authenticated: false, username: null }
const HARDWARE_POLL_INTERVAL_MS = 4_000
const DESKTOP_HEARTBEAT_INTERVAL_MS = 4_000
// /events/next is a RAM-only FIFO read. Poll promptly without overlapping
// requests; the scan still needs one authoritative device response.
const HARDWARE_EVENT_POLL_INTERVAL_MS = 250
function formatHardwareMode(mode: HardwareMode | null): string {
  if (mode === null) return 'Unavailable'
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

function formatHardwareAvailability(value: boolean | null): string {
  if (value === null) return 'Unavailable'
  return value ? 'Available' : 'Unavailable'
}

function formatStaleAvailability(value: boolean | null, checking: boolean): string {
  if (value === true) return 'Last known: Available'
  return value === null && checking ? 'Checking…' : 'Status unavailable'
}

function formatRtcAvailability(status: HardwareStatusDto): string {
  if (status.rtcState === 'needs_sync') return 'Needs synchronization'
  if (status.rtcState === 'unavailable') return 'Unavailable'
  return formatHardwareAvailability(status.rtc)
}

function transportFailureStatus(
  previous: HardwareStatusDto | null,
  connection: HardwareStatusDto['connection']
): HardwareStatusDto {
  // Keep only stale component observations. Offline journal metadata must not
  // remain actionable after a failed IPC/status refresh.
  return {
    connection,
    device: previous?.device ?? null,
    mode: previous?.mode ?? null,
    rtc: previous?.rtc ?? null,
    sd: previous?.sd ?? null,
    ...(previous?.rtcState === undefined
      ? {}
      : { rtcState: previous.rtcState, rtcReason: previous.rtcReason })
  }
}

function hardwareTimingDebugEnabled(): boolean {
  return import.meta.env.DEV &&
    window.sessionStorage.getItem('dentalHardwareTiming') === '1'
}

const sectionMetadata: Record<
  NavigationItem,
  { eyebrow: string; title: string; description: string }
> = {
  'ITEM INVENTORY': {
    eyebrow: 'Inventory',
    title: 'Item Inventory',
    description: 'Review, search, and maintain dental supplies and their stock levels.'
  },
  'MOVEMENT HISTORY': {
    eyebrow: 'Audit trail',
    title: 'Movement History',
    description: 'Review the permanent chronological record of inventory adjustments.'
  },
  'ADD NEW ITEM': {
    eyebrow: 'Registration',
    title: 'Add New Item',
    description: 'Register a barcode-enabled inventory product.'
  },
  'SYNC OFFLINE': {
    eyebrow: 'Clinic kiosk',
    title: 'Sync Offline',
    description: 'Reconcile pending kiosk transactions and refresh its authoritative inventory.'
  }
}

function LoginScreen({
  setupRequired,
  setupComplete,
  onSetupComplete,
  onAuthenticated
}: {
  setupRequired: boolean
  setupComplete: boolean
  onSetupComplete: () => void
  onAuthenticated: (session: AuthSession) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [passwordToggleRevision, setPasswordToggleRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setError(null)

    try {
      if (setupRequired) {
        if (password !== confirmPassword) {
          setError('Passwords do not match.')
          return
        }

        const setupResult = await window.desktopApi.auth.createFirstAdmin({ username, password })
        if (!setupResult.ok) {
          if (setupResult.code === 'ALREADY_CONFIGURED') {
            setPassword('')
            setConfirmPassword('')
            onSetupComplete()
            return
          }
          setError(setupResult.code === 'INVALID_CREDENTIALS'
            ? 'Use a username of up to 100 characters and a password of at least 8 characters.'
            : 'Administrator setup is unavailable. Please try again.')
          return
        }

        setPassword('')
        setConfirmPassword('')
        setPasswordVisible(false)
        onSetupComplete()
        return
      }

      const result = await window.desktopApi.auth.login({ username, password })
      if (!result.ok) {
        setPassword('')
        setPasswordVisible(false)
        setError('Access Denied')
        return
      }

      setPassword('')
      setPasswordVisible(false)
      onAuthenticated(result.session)
    } catch {
      setPassword('')
      setConfirmPassword('')
      setPasswordVisible(false)
      setError(setupRequired ? 'Administrator setup is unavailable. Please try again.' : 'Access Denied')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <header className="login-brand">
          <span className="clinic-logo clinic-logo--login">
            <img src={clinicLogo} alt="Any Time Dental clinic logo" />
          </span>
          <span className="login-brand__name">
            <strong>Any Time Dental</strong>
            <small>Dental care, anytime</small>
          </span>
        </header>

        <div className="login-panel__content">
          <p className="login-panel__kicker">STAFF PORTAL</p>
          <h1 id="login-title">Dental Inventory Management System</h1>
          <p className="login-panel__intro">
            {setupRequired
              ? 'Create the first administrator account for this installation.'
              : setupComplete
                ? 'Administrator account created. Sign in to continue.'
                : 'Sign in to access and manage clinic inventory.'}
          </p>

          <form className="login-form" onSubmit={submitLogin}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete={setupRequired ? 'new-username' : 'username'}
              autoFocus
              maxLength={setupRequired ? 100 : 128}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={submitting}
              required
            />

            <label htmlFor="password">Password</label>
            <div className="password-field">
              <input
                id="password"
                name="password"
                type={passwordVisible ? 'text' : 'password'}
                autoComplete={setupRequired ? 'new-password' : 'current-password'}
                maxLength={1024}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
                required
              />
              <button
                type="button"
                className="password-visibility-button"
                aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                title={passwordVisible ? 'Hide password' : 'Show password'}
                aria-pressed={passwordVisible}
                onClick={() => {
                  setPasswordVisible((current) => !current)
                  setPasswordToggleRevision((current) => current + 1)
                }}
                disabled={submitting}
              >
                <span
                  key={passwordToggleRevision}
                  className={`password-visibility-button__icon${passwordToggleRevision > 0 ? ' is-toggling' : ''}`}
                  data-icon={passwordVisible ? 'eye' : 'eye-off'}
                  aria-hidden="true"
                >
                  {passwordVisible ? (
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                      <circle cx="12" cy="12" r="2.7" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M3 4.5 21 19.5" />
                      <path d="M10.5 6.15A10.3 10.3 0 0 1 12 6c6 0 9.5 6 9.5 6a15 15 0 0 1-3.2 3.65M6.35 7.25A15.8 15.8 0 0 0 2.5 12s3.5 6 9.5 6a10 10 0 0 0 2.05-.2" />
                      <path d="M9.8 9.8a3.1 3.1 0 0 0 4.4 4.4" />
                    </svg>
                  )}
                </span>
              </button>
            </div>

            {setupRequired && (
              <>
                <label htmlFor="confirm-password">Confirm password</label>
                <input
                  id="confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={1024}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={submitting}
                  required
                />
              </>
            )}

            {error !== null && (
              <div className="access-denied" role="alert">
                {error}
              </div>
            )}

            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting
                ? (setupRequired ? 'Creating account…' : 'Signing in…')
                : (setupRequired ? 'Create Administrator' : 'Sign In')}
            </button>
          </form>
        </div>
        <p className="login-panel__footnote">Authorized personnel only</p>
      </section>
      <aside className="login-context" aria-label="Any Time Dental clinic team">
        <div className="staff-collage">
          <figure className="staff-photo staff-photo--primary">
            <img
              className="staff-photo__image--uncropped"
              src={staffPhotoOne}
              alt="Any Time Dental clinic team"
            />
          </figure>
          <figure className="staff-photo staff-photo--care">
            <img src={staffPhotoTwo} alt="Any Time Dental dentist providing patient care" />
          </figure>
          <figure className="staff-photo staff-photo--reception">
            <img src={staffPhotoThree} alt="Any Time Dental reception team" />
          </figure>
        </div>
        <div className="login-context__glass">
          <span>READY FOR EVERY PATIENT</span>
          <h2>Smarter inventory. Smoother care.</h2>
          <p>Keep essential clinic supplies organized, visible, and ready when they're needed.</p>
        </div>
      </aside>
    </main>
  )
}

function ApplicationShell({ session, onLogout }: { session: AuthSession; onLogout: () => void }) {
  const [activeItem, setActiveItem] = useState<NavigationItem>('ITEM INVENTORY')
  const [loggingOut, setLoggingOut] = useState(false)
  const [inventoryRefreshVersion, setInventoryRefreshVersion] = useState(0)
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0)
  const [inventoryNotice, setInventoryNotice] = useState<string | null>(null)
  const [hardwareStatus, setHardwareStatus] = useState<HardwareStatusDto | null>(null)
  const [deviceSetupOpen, setDeviceSetupOpen] = useState(false)
  const [hardwareConfigVersion, setHardwareConfigVersion] = useState(0)
  const [pendingHardwareEvent, setPendingHardwareEvent] =
    useState<HardwareTransactionEvent | null>(null)
  const [acknowledgingHardwareEvent, setAcknowledgingHardwareEvent] = useState(false)
  const [hardwareEventError, setHardwareEventError] = useState<string | null>(null)
  const [hardwareEventOpen, setHardwareEventOpen] = useState(false)
  const [pendingHardwareReceipt, setPendingHardwareReceipt] =
    useState<HardwareTransactionReceipt | null>(null)
  const [hardwareTransactionNotice, setHardwareTransactionNotice] = useState<string | null>(null)
  const hardwareEventRequest = useRef<Promise<HardwareTransactionEvent | null> | null>(null)
  const desktopHeartbeatRequest = useRef<Promise<boolean> | null>(null)
  const statusIpcFailures = useRef(0)
  const hardwareAcknowledgementInFlight = useRef(false)
  const lastCommittedHardwareEvent = useRef<string | null>(null)
  const hardwareEventPreviousFocus = useRef<HTMLElement | null>(null)
  const resumeHardwareEventButton = useRef<HTMLButtonElement | null>(null)
  const hardwareEventVisible = pendingHardwareEvent !== null && hardwareEventOpen
  const activeSection = sectionMetadata[activeItem]
  const hardwareConnectionLabel =
    hardwareStatus === null
      ? 'Checking…'
      : hardwareStatus.connection === 'CONNECTED'
        ? 'Connected'
        : hardwareStatus.connection === 'CHECKING'
          ? 'Checking…'
          : hardwareStatus.connection === 'NOT_CONFIGURED'
            ? 'Not configured' : 'Disconnected'
  const hardwareStatusModifier =
    hardwareStatus === null
      ? 'is-checking'
      : hardwareStatus.connection === 'CONNECTED'
        ? 'is-connected'
        : hardwareStatus.connection === 'CHECKING'
          ? 'is-checking'
          : 'is-offline'

  useEffect(() => {
    if (inventoryNotice === null) return undefined

    const timeout = window.setTimeout(() => setInventoryNotice(null), 5_000)
    return () => window.clearTimeout(timeout)
  }, [inventoryNotice])

  useEffect(() => {
    if (hardwareTransactionNotice === null) return undefined

    const timeout = window.setTimeout(() => setHardwareTransactionNotice(null), 8_000)
    return () => window.clearTimeout(timeout)
  }, [hardwareTransactionNotice])

  useEffect(() => {
    if (loggingOut) return undefined

    let active = true
    let heartbeatTimer: number | undefined

    async function sendDesktopHeartbeat(): Promise<void> {
      const heartbeatStartedAt = Date.now()
      try {
        // Reuse an outstanding request during StrictMode effect replay and
        // never schedule the next lease refresh until this one has settled.
        desktopHeartbeatRequest.current ??=
          window.desktopApi.hardware.sendDesktopHeartbeat()
        await desktopHeartbeatRequest.current
      } catch {
        // Presence recovery is automatic on the next interval. Inventory and
        // the authenticated shell stay usable while hardware is unavailable.
      } finally {
        desktopHeartbeatRequest.current = null
        if (active) {
          const elapsedMs = Date.now() - heartbeatStartedAt
          const nextHeartbeatDelayMs = Math.max(
            0,
            DESKTOP_HEARTBEAT_INTERVAL_MS - elapsedMs
          )
          heartbeatTimer = window.setTimeout(() => {
            void sendDesktopHeartbeat()
          }, nextHeartbeatDelayMs)
        }
      }
    }

    void sendDesktopHeartbeat()
    return () => {
      active = false
      if (heartbeatTimer !== undefined) window.clearTimeout(heartbeatTimer)
    }
  }, [loggingOut, hardwareConfigVersion])

  useEffect(() => {
    let active = true
    let pollTimer: number | undefined

    async function pollHardwareStatus(): Promise<void> {
      const pollStartedAt = Date.now()
      try {
        const status = await window.desktopApi.hardware.getStatus()
        statusIpcFailures.current = 0
        if (active) setHardwareStatus(status)
      } catch {
        if (active) {
          statusIpcFailures.current += 1
          setHardwareStatus((previous) => transportFailureStatus(
            previous,
            previous?.connection === 'CONNECTED' && statusIpcFailures.current === 1
              ? 'CHECKING' : 'OFFLINE'
          ))
        }
      } finally {
        if (active) {
          const elapsedMs = Date.now() - pollStartedAt
          const nextPollDelayMs = Math.max(0, HARDWARE_POLL_INTERVAL_MS - elapsedMs)
          pollTimer = window.setTimeout(() => {
            void pollHardwareStatus()
          }, nextPollDelayMs)
        }
      }
    }

    void pollHardwareStatus()
    return () => {
      active = false
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [hardwareConfigVersion])

  useEffect(() => {
    if (loggingOut || pendingHardwareEvent !== null) {
      if (hardwareTimingDebugEnabled()) {
        console.debug(`[hardware poll] renderer event skipped=${loggingOut ? 'logout' : 'modal_active'}`)
      }
      return undefined
    }

    let active = true
    let pollTimer: number | undefined

    async function pollHardwareEvent(): Promise<void> {
      const pollStartedAt = Date.now()
      let eventReceived = false
      let requestFailed = false
      if (hardwareTimingDebugEnabled()) console.debug('[hardware poll] renderer event start')

      try {
        // Reuse an outstanding request during StrictMode effect replay, too.
        hardwareEventRequest.current ??= window.desktopApi.hardware.getNextTransactionEvent()
        const event = await hardwareEventRequest.current
        if (active && event !== null) {
          eventReceived = true
          hardwareEventPreviousFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          setHardwareEventError(null)
          setPendingHardwareReceipt(null)
          setPendingHardwareEvent(event)
          setHardwareEventOpen(true)
        }
      } catch {
        requestFailed = true
        // Event delivery is best-effort while the device is unavailable. Inventory remains usable.
      } finally {
        if (hardwareTimingDebugEnabled()) {
          console.debug(`[hardware poll] renderer event end result=${requestFailed ? 'failed' : eventReceived ? 'event' : 'empty'} ` +
            `elapsedMs=${Date.now() - pollStartedAt}`)
        }
        hardwareEventRequest.current = null
        if (active && !eventReceived) {
          const elapsedMs = Date.now() - pollStartedAt
          const nextPollDelayMs = Math.max(0, HARDWARE_EVENT_POLL_INTERVAL_MS - elapsedMs)
          pollTimer = window.setTimeout(() => {
            void pollHardwareEvent()
          }, nextPollDelayMs)
        }
      }
    }

    void pollHardwareEvent()
    return () => {
      active = false
      if (pollTimer !== undefined) window.clearTimeout(pollTimer)
    }
  }, [loggingOut, pendingHardwareEvent, hardwareConfigVersion])

  useEffect(() => {
    if (hardwareEventVisible) return

    if (hardwareEventPreviousFocus.current?.isConnected) {
      hardwareEventPreviousFocus.current.focus()
    } else {
      resumeHardwareEventButton.current?.focus()
    }
    hardwareEventPreviousFocus.current = null
  }, [hardwareEventVisible])

  function renderActiveSection(): ReactNode {
    switch (activeItem) {
      case 'ITEM INVENTORY':
        return (
          <InventoryPage
            refreshVersion={inventoryRefreshVersion}
            notice={inventoryNotice}
            onHistoryChanged={() => setHistoryRefreshVersion((current) => current + 1)}
          />
        )
      case 'MOVEMENT HISTORY':
        return <MovementHistoryPage refreshVersion={historyRefreshVersion} />
      case 'ADD NEW ITEM':
        return (
          <AddItemPage
            onCreated={(itemName) => {
              setInventoryNotice(`${itemName} was added successfully.`)
              setInventoryRefreshVersion((current) => current + 1)
              setActiveItem('ITEM INVENTORY')
            }}
          />
        )
      case 'SYNC OFFLINE':
        return (
          <SyncOfflinePage
            pendingCount={hardwareStatus?.pendingSyncItems}
            offlineReady={hardwareStatus?.offlineReady}
            offlineJournalState={hardwareStatus?.offlineJournalState}
            offlineAckState={hardwareStatus?.offlineAckState}
          />
        )
    }
  }

  async function logout(): Promise<void> {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await window.desktopApi.auth.logout()
    } finally {
      onLogout()
    }
  }

  async function acknowledgeUncommittedHardwareEvent(failureMessage?: string): Promise<void> {
    if (pendingHardwareEvent === null || hardwareAcknowledgementInFlight.current) return

    const eventId = pendingHardwareEvent.eventId
    if (import.meta.env.DEV &&
        window.sessionStorage.getItem('dentalHardwareTiming') === '1') {
      console.debug('[hardware event UI]', {
        operation: 'CANCEL', expectedEventId: eventId,
        expectedMode: pendingHardwareEvent.mode
      })
    }
    hardwareAcknowledgementInFlight.current = true
    setAcknowledgingHardwareEvent(true)
    setHardwareEventError(null)

    try {
      const result = await window.desktopApi.hardware.acknowledgeTransactionEvent(eventId)
      if (!result.ok) {
        setHardwareEventError(result.error.message)
        return
      }
      if (result.value.eventId !== eventId) {
        setHardwareEventError(failureMessage ??
          'Could not acknowledge this scan. Check the ESP32 connection and try again.')
        return
      }

      setPendingHardwareEvent((currentEvent) =>
        currentEvent?.eventId === eventId ? null : currentEvent
      )
      setPendingHardwareReceipt(null)
    } catch {
      setHardwareEventError(failureMessage ??
        'Could not acknowledge this scan. Check the ESP32 connection and try again.')
    } finally {
      hardwareAcknowledgementInFlight.current = false
      setAcknowledgingHardwareEvent(false)
    }
  }

  const handleHardwareTransactionCommitted = useCallback(
    (receipt: HardwareTransactionReceipt): void => {
      setPendingHardwareReceipt(receipt)
      if (lastCommittedHardwareEvent.current !== receipt.eventId) {
        lastCommittedHardwareEvent.current = receipt.eventId
        setInventoryRefreshVersion((current) => current + 1)
        setHistoryRefreshVersion((current) => current + 1)
      }
    },
    []
  )

  const handleHardwareTransactionCompleted = useCallback(
    (receipt: HardwareTransactionReceipt): void => {
      setHardwareTransactionNotice(
        `${receipt.itemName}: ${receipt.mode.toUpperCase()} saved. ` +
          `New stock ${receipt.newTotal} (${receipt.status}).`
      )
      setHardwareEventError(null)
      setHardwareEventOpen(false)
      setPendingHardwareReceipt(null)
      setPendingHardwareEvent((currentEvent) =>
        currentEvent?.eventId === receipt.eventId ? null : currentEvent
      )
    },
    []
  )

  return (
    <div className="app-shell">
      <aside className="sidebar" inert={hardwareEventVisible || deviceSetupOpen}>
        <div className="sidebar__brand">
          <span className="clinic-logo clinic-logo--sidebar">
            <img src={clinicLogo} alt="" />
          </span>
          <div>
            <strong>Any Time Dental</strong>
            <small>Inventory management</small>
          </div>
        </div>

        <nav className="navigation" aria-label="Primary navigation">
          <p>MAIN MENU</p>
          <div role="tablist" aria-orientation="vertical">
            {NAVIGATION_ITEMS.map((item, index) => (
              <button
                key={item}
                className={item === activeItem ? 'navigation__item is-active' : 'navigation__item'}
                type="button"
                role="tab"
                aria-selected={item === activeItem}
                aria-controls="application-section"
                onClick={() => setActiveItem(item)}
              >
                <span className="navigation__number" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>{item}</span>
              </button>
            ))}
          </div>
        </nav>

        <div
          className={`sidebar__status ${hardwareStatusModifier}`}
          role="status"
          aria-live="polite"
          aria-label="Inventory device status"
        >
          <div className="sidebar__status-summary">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <strong>Inventory Device</strong>
              <small>{hardwareConnectionLabel}</small>
            </div>
          </div>
          <dl className="hardware-status-details">
            <div>
              <dt>Operating Mode</dt>
              <dd>
                {hardwareStatus === null || hardwareStatus.connection === 'CHECKING'
                  ? 'Checking…'
                  : hardwareStatus.connection === 'OFFLINE'
                    ? 'Unavailable'
                    : formatHardwareMode(hardwareStatus.mode)}
              </dd>
            </div>
            <div>
              <dt>System Clock</dt>
              <dd>
                {hardwareStatus === null
                  ? 'Checking…'
                  : hardwareStatus.connection === 'CONNECTED'
                    ? formatRtcAvailability(hardwareStatus)
                    : formatStaleAvailability(
                        hardwareStatus.rtc, hardwareStatus.connection === 'CHECKING'
                      )}
              </dd>
            </div>
            <div>
              <dt>Local Storage</dt>
              <dd>
                {hardwareStatus === null
                  ? 'Checking…'
                  : hardwareStatus.connection === 'CONNECTED'
                    ? formatHardwareAvailability(hardwareStatus.sd)
                    : formatStaleAvailability(
                        hardwareStatus.sd, hardwareStatus.connection === 'CHECKING'
                      )}
              </dd>
            </div>
          </dl>
          <button className="sidebar__device-setup" type="button"
            onClick={() => setDeviceSetupOpen(true)} disabled={pendingHardwareEvent !== null}>
            {hardwareStatus?.connection === 'NOT_CONFIGURED' ? 'Set Up Device' : 'Device Setup'}
          </button>
        </div>
      </aside>

      <div className="workspace" inert={hardwareEventVisible || deviceSetupOpen}>
        <header className="topbar">
          <div className="topbar__location">
            <span>DENTAL INVENTORY MANAGEMENT SYSTEM</span>
            <strong>{activeItem}</strong>
          </div>
          <div className="account-menu">
            <div className="account-avatar" aria-hidden="true">
              {session.username?.slice(0, 1).toUpperCase() ?? 'A'}
            </div>
            <div>
              <strong>{session.username ?? 'Administrator'}</strong>
              <small>Administrator</small>
            </div>
            <button type="button" onClick={logout} disabled={loggingOut}>
              {loggingOut ? 'Logging out…' : 'Logout'}
            </button>
          </div>
        </header>

        <main className="content" id="application-section" role="tabpanel">
          {pendingHardwareEvent !== null && !hardwareEventOpen && (
            <div className="hardware-pending-scan" role="status">
              <p>
                {pendingHardwareReceipt === null
                  ? `A ${pendingHardwareEvent.mode.toUpperCase()} scan is pending. Resume to continue safely.`
                  : pendingHardwareReceipt.resultDeliveredToHardware
                    ? `The ${pendingHardwareEvent.mode.toUpperCase()} transaction was saved. ESP32 acknowledgement is pending.`
                    : `The ${pendingHardwareEvent.mode.toUpperCase()} transaction was saved. ESP32 stock feedback is pending.`}
              </p>
              <button ref={resumeHardwareEventButton} type="button" className="secondary-button" onClick={() => {
                hardwareEventPreviousFocus.current = document.activeElement instanceof HTMLElement
                  ? document.activeElement : null
                setHardwareEventError(null)
                setHardwareEventOpen(true)
              }}>Resume pending scan</button>
            </div>
          )}
          {hardwareTransactionNotice !== null && (
            <div className="form-alert form-alert--success hardware-transaction-notice" role="status">
              {hardwareTransactionNotice}
            </div>
          )}
          <section className="page-heading">
            <div>
              <p>{activeSection.eyebrow}</p>
              <h1>{activeSection.title}</h1>
              <span>{activeSection.description}</span>
            </div>
            <div className="page-brand" aria-label="Any Time Dental">
              <span className="page-brand__dot" aria-hidden="true" />
              <div>
                <strong>Any Time Dental</strong>
                <small>Clinic inventory</small>
              </div>
            </div>
          </section>

          <section className="content-card">{renderActiveSection()}</section>
        </main>
      </div>
      <DeviceSetupDialog open={deviceSetupOpen} onClose={() => setDeviceSetupOpen(false)}
        onSaved={() => {
          setHardwareStatus(null)
          setHardwareConfigVersion((value) => value + 1)
        }} />

      {pendingHardwareEvent !== null && (
        <HardwareTransactionDialog
          key={pendingHardwareEvent.eventId}
          event={pendingHardwareEvent}
          open={hardwareEventOpen}
          acknowledging={acknowledgingHardwareEvent}
          acknowledgementError={hardwareEventError}
          onReject={() => void acknowledgeUncommittedHardwareEvent()}
          onCancel={() => void acknowledgeUncommittedHardwareEvent(
            'Could not cancel this scan. Check the ESP32 connection and try again.'
          )}
          onReviewLater={() => {
            if (import.meta.env.DEV &&
                window.sessionStorage.getItem('dentalHardwareTiming') === '1') {
              console.debug('[hardware event UI]', {
                operation: 'REVIEW_LATER', expectedEventId: pendingHardwareEvent.eventId,
                expectedMode: pendingHardwareEvent.mode, deviceRequest: false
              })
            }
            setHardwareEventOpen(false)
          }}
          onCommitted={handleHardwareTransactionCommitted}
          onCompleted={handleHardwareTransactionCompleted}
        />
      )}
    </div>
  )
}

export function App() {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null)
  const [setupComplete, setSetupComplete] = useState(false)

  useEffect(() => {
    const preventFileNavigation = (event: DragEvent): void => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        event.preventDefault()
      }
    }

    window.addEventListener('dragover', preventFileNavigation)
    window.addEventListener('drop', preventFileNavigation)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation)
      window.removeEventListener('drop', preventFileNavigation)
    }
  }, [])

  useEffect(() => {
    let active = true

    Promise.all([window.desktopApi.auth.getSession(), window.desktopApi.auth.needsSetup()])
      .then(([currentSession, needsSetup]) => {
        if (active) {
          setSession(currentSession)
          setSetupRequired(needsSetup)
        }
      })
      .catch(() => {
        if (active) {
          setSession(EMPTY_SESSION)
          setSetupRequired(false)
        }
      })

    return () => {
      active = false
    }
  }, [])

  if (session === null || setupRequired === null) {
    return (
      <main className="startup-screen" aria-live="polite">
        <div className="startup-spinner" aria-hidden="true" />
        <p>Starting Any Time Dental inventory…</p>
      </main>
    )
  }

  if (!session.authenticated) {
    return <LoginScreen
      setupRequired={setupRequired}
      setupComplete={setupComplete}
      onSetupComplete={() => {
        setSetupRequired(false)
        setSetupComplete(true)
      }}
      onAuthenticated={setSession}
    />
  }

  return <ApplicationShell session={session} onLogout={() => setSession(EMPTY_SESSION)} />
}
