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
const HARDWARE_EVENT_POLL_INTERVAL_MS = 1_000
const OFFLINE_HARDWARE_STATUS: HardwareStatusDto = {
  connection: 'OFFLINE',
  device: null,
  mode: null,
  rtc: null,
  sd: null
}

function formatHardwareMode(mode: HardwareMode | null): string {
  if (mode === null) return 'Unavailable'
  return mode.charAt(0).toUpperCase() + mode.slice(1)
}

function formatHardwareAvailability(value: boolean | null): string {
  if (value === null) return 'Unavailable'
  return value ? 'Available' : 'Unavailable'
}

function formatRtcAvailability(status: HardwareStatusDto): string {
  if (status.rtcState === 'needs_sync') return 'Needs synchronization'
  if (status.rtcState === 'unavailable') return 'Hardware unavailable'
  return formatHardwareAvailability(status.rtc)
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

function LoginScreen({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function submitLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setError(null)

    try {
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
      setPasswordVisible(false)
      setError('Access Denied')
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
          <p className="login-panel__intro">Sign in to access and manage clinic inventory.</p>

          <form className="login-form" onSubmit={submitLogin}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              maxLength={128}
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
                autoComplete="current-password"
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
                onClick={() => setPasswordVisible((current) => !current)}
                disabled={submitting}
              >
                <span aria-hidden="true">{passwordVisible ? '◉' : '◎'}</span>
              </button>
            </div>

            {error !== null && (
              <div className="access-denied" role="alert">
                {error}
              </div>
            )}

            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign In'}
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
        : 'Offline'
  const hardwareStatusModifier =
    hardwareStatus === null
      ? 'is-checking'
      : hardwareStatus.connection === 'CONNECTED'
        ? 'is-connected'
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
  }, [loggingOut])

  useEffect(() => {
    let active = true
    let pollTimer: number | undefined

    async function pollHardwareStatus(): Promise<void> {
      const pollStartedAt = Date.now()
      try {
        const status = await window.desktopApi.hardware.getStatus()
        if (active) setHardwareStatus(status)
      } catch {
        if (active) setHardwareStatus(OFFLINE_HARDWARE_STATUS)
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
  }, [])

  useEffect(() => {
    if (loggingOut || pendingHardwareEvent !== null) return undefined

    let active = true
    let pollTimer: number | undefined

    async function pollHardwareEvent(): Promise<void> {
      const pollStartedAt = Date.now()
      let eventReceived = false

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
        // Event delivery is best-effort while the device is unavailable. Inventory remains usable.
      } finally {
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
  }, [loggingOut, pendingHardwareEvent])

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
      <aside className="sidebar" inert={hardwareEventVisible}>
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
          aria-label="ESP32 hardware status"
        >
          <div className="sidebar__status-summary">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <strong>ESP32</strong>
              <small>{hardwareConnectionLabel}</small>
            </div>
          </div>
          <dl className="hardware-status-details">
            <div>
              <dt>Hardware mode</dt>
              <dd>
                {hardwareStatus === null
                  ? 'Checking…'
                  : formatHardwareMode(hardwareStatus.mode)}
              </dd>
            </div>
            <div>
              <dt>RTC</dt>
              <dd>
                {hardwareStatus === null
                  ? 'Checking…'
                  : formatRtcAvailability(hardwareStatus)}
              </dd>
            </div>
            <div>
              <dt>MicroSD</dt>
              <dd>
                {hardwareStatus === null
                  ? 'Checking…'
                  : formatHardwareAvailability(hardwareStatus.sd)}
              </dd>
            </div>
          </dl>
        </div>
      </aside>

      <div className="workspace" inert={hardwareEventVisible}>
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
          onReviewLater={() => setHardwareEventOpen(false)}
          onCommitted={handleHardwareTransactionCommitted}
          onCompleted={handleHardwareTransactionCompleted}
        />
      )}
    </div>
  )
}

export function App() {
  const [session, setSession] = useState<AuthSession | null>(null)

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

    window.desktopApi.auth
      .getSession()
      .then((currentSession) => {
        if (active) setSession(currentSession)
      })
      .catch(() => {
        if (active) setSession(EMPTY_SESSION)
      })

    return () => {
      active = false
    }
  }, [])

  if (session === null) {
    return (
      <main className="startup-screen" aria-live="polite">
        <div className="startup-spinner" aria-hidden="true" />
        <p>Starting Any Time Dental inventory…</p>
      </main>
    )
  }

  if (!session.authenticated) {
    return <LoginScreen onAuthenticated={setSession} />
  }

  return <ApplicationShell session={session} onLogout={() => setSession(EMPTY_SESSION)} />
}
