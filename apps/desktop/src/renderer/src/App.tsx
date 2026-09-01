import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AuthSession } from '../../shared/ipc-contract'
import clinicLogo from './assets/branding/any-time-dental-logo.png'
import staffPhotoOne from './assets/branding/staff-01.jpg'
import staffPhotoTwo from './assets/branding/staff-02.jpg'
import staffPhotoThree from './assets/branding/staff-03.jpg'
import { AddItemPage } from './pages/AddItemPage'
import { InventoryPage } from './pages/InventoryPage'
import { MovementHistoryPage } from './pages/MovementHistoryPage'

const NAVIGATION_ITEMS = [
  'ITEM INVENTORY',
  'MOVEMENT HISTORY',
  'ADD NEW ITEM',
  'SYNC OFFLINE'
] as const

type NavigationItem = (typeof NAVIGATION_ITEMS)[number]

const EMPTY_SESSION: AuthSession = { authenticated: false, username: null }

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
    description: 'Keep inventory ready for future kiosk synchronization.'
  }
}

function EmptyState({
  badge,
  title,
  message
}: {
  badge: string
  title: string
  message: string
}): ReactNode {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="phase-badge">{badge}</span>
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  )
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (session: AuthSession) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
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
        setError('Access Denied')
        return
      }

      setPassword('')
      onAuthenticated(result.session)
    } catch {
      setPassword('')
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
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              required
            />

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
  const activeSection = sectionMetadata[activeItem]

  useEffect(() => {
    if (inventoryNotice === null) return undefined

    const timeout = window.setTimeout(() => setInventoryNotice(null), 5_000)
    return () => window.clearTimeout(timeout)
  }, [inventoryNotice])

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
          <EmptyState
            badge="Clinic kiosk"
            title="Offline synchronization is waiting for the kiosk"
            message="Offline synchronization will become available when the inventory kiosk is connected."
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
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

        <div className="sidebar__status">
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>System ready</strong>
            <small>Clinic inventory workspace</small>
          </div>
        </div>
      </aside>

      <div className="workspace">
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
