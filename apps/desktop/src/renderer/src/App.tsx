import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AuthSession } from '../../shared/ipc-contract'

const NAVIGATION_ITEMS = [
  'ITEM INVENTORY',
  'MOVEMENT HISTORY',
  'ADD NEW ITEM',
  'SYNC OFFLINE'
] as const

type NavigationItem = (typeof NAVIGATION_ITEMS)[number]

const EMPTY_SESSION: AuthSession = { authenticated: false, username: null }

const sectionContent: Record<
  NavigationItem,
  { eyebrow: string; title: string; description: string; content: ReactNode }
> = {
  'ITEM INVENTORY': {
    eyebrow: 'Inventory',
    title: 'Item Inventory',
    description: 'Review dental supplies and their stock levels.',
    content: (
      <EmptyState
        badge="Phase 2"
        title="Inventory records will appear here"
        message="Product search, category filters, stock indicators, and editing are intentionally deferred until the next approved phase."
      />
    )
  },
  'MOVEMENT HISTORY': {
    eyebrow: 'Audit trail',
    title: 'Movement History',
    description: 'Review chronological restock and checkout activity.',
    content: (
      <EmptyState
        badge="Phase 2"
        title="No movement records to display"
        message="Online and synchronized offline transactions will be shown here after transaction execution is implemented."
      />
    )
  },
  'ADD NEW ITEM': {
    eyebrow: 'Registration',
    title: 'Add New Item',
    description: 'Register a barcode-enabled inventory product.',
    content: (
      <EmptyState
        badge="Hardware disabled"
        title="Please scan the item barcode using the hardware scanner to begin."
        message="Scanner activation remains disabled in Phase 1 while its electrical direction and PCB connections are being verified."
      />
    )
  },
  'SYNC OFFLINE': {
    eyebrow: 'MicroSD synchronization',
    title: 'Sync Offline',
    description: 'Preview and import transactions recorded by the kiosk.',
    content: (
      <EmptyState
        badge="Phase 2+"
        title="Offline synchronization is not active"
        message="The production ESP32 transport is deliberately unimplemented in this foundational phase."
      />
    )
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
        <div className="brand-mark brand-mark--large" aria-hidden="true">
          <span>DI</span>
        </div>
        <p className="login-panel__kicker">Clinic administration</p>
        <h1 id="login-title">Dental Inventory System</h1>
        <p className="login-panel__intro">
          Sign in with the configured administrator account to continue.
        </p>

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
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="login-panel__footnote">Authorized clinic administrator access only</p>
      </section>
      <aside className="login-context" aria-label="System overview">
        <div>
          <span className="context-label">LOCAL · SECURE · OFFLINE-READY</span>
          <h2>A focused inventory workspace for dental supplies.</h2>
          <p>
            Inventory information remains on this Windows computer. Hardware activation is safely
            disabled during Phase 1.
          </p>
        </div>
      </aside>
    </main>
  )
}

function ApplicationShell({ session, onLogout }: { session: AuthSession; onLogout: () => void }) {
  const [activeItem, setActiveItem] = useState<NavigationItem>('ITEM INVENTORY')
  const [loggingOut, setLoggingOut] = useState(false)
  const activeSection = sectionContent[activeItem]

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
          <div className="brand-mark" aria-hidden="true">
            <span>DI</span>
          </div>
          <div>
            <strong>Dental Inventory</strong>
            <small>Clinic workspace</small>
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
            <strong>Desktop ready</strong>
            <small>Hardware inactive</small>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar__location">
            <span>ADMINISTRATION</span>
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
            <div className="phase-indicator">
              <span>PHASE</span>
              <strong>01</strong>
            </div>
          </section>

          <section className="content-card">{activeSection.content}</section>
        </main>
      </div>
    </div>
  )
}

export function App() {
  const [session, setSession] = useState<AuthSession | null>(null)

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
        <p>Starting Dental Inventory System…</p>
      </main>
    )
  }

  if (!session.authenticated) {
    return <LoginScreen onAuthenticated={setSession} />
  }

  return <ApplicationShell session={session} onLogout={() => setSession(EMPTY_SESSION)} />
}
