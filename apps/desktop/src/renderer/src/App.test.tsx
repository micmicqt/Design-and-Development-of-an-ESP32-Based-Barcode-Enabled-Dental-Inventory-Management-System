import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopApi } from '../../shared/ipc-contract'
import { App } from './App'

function installDesktopApi(api: DesktopApi): void {
  Object.defineProperty(window, 'desktopApi', {
    configurable: true,
    value: api
  })
}

describe('Phase 1 desktop shell', () => {
  beforeEach(() => {
    installDesktopApi({
      auth: {
        getSession: vi.fn().mockResolvedValue({ authenticated: false, username: null }),
        login: vi.fn().mockResolvedValue({
          ok: false,
          message: 'Access Denied',
          session: { authenticated: false, username: null }
        }),
        logout: vi.fn().mockResolvedValue({ authenticated: false, username: null })
      }
    })
  })

  it('shows Access Denied after invalid credentials', async () => {
    const user = userEvent.setup()
    render(<App />)

    const username = await screen.findByLabelText('Username')
    const password = screen.getByLabelText('Password')
    const signIn = screen.getByRole('button', { name: 'Sign in' })

    expect(username).toBeVisible()
    expect(password).toBeVisible()
    expect(signIn).toBeVisible()

    await user.type(username, 'admin')
    await user.type(password, 'incorrect')
    await user.click(signIn)

    expect(await screen.findByRole('alert')).toHaveTextContent('Access Denied')
  })

  it('opens the shell, changes sections, and logs out', async () => {
    const user = userEvent.setup()
    const login = vi.fn().mockResolvedValue({
      ok: true,
      session: { authenticated: true, username: 'admin' }
    })
    const logout = vi.fn().mockResolvedValue({ authenticated: false, username: null })

    installDesktopApi({
      auth: {
        getSession: vi.fn().mockResolvedValue({ authenticated: false, username: null }),
        login,
        logout
      }
    })

    render(<App />)
    await user.type(await screen.findByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'valid-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    const itemInventoryTab = await screen.findByRole('tab', { name: 'ITEM INVENTORY' })
    expect(itemInventoryTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Item Inventory' })).toBeVisible()

    const sections = [
      ['MOVEMENT HISTORY', 'Movement History'],
      ['ADD NEW ITEM', 'Add New Item'],
      ['SYNC OFFLINE', 'Sync Offline'],
      ['ITEM INVENTORY', 'Item Inventory']
    ] as const

    for (const [tabName, headingName] of sections) {
      const tab = screen.getByRole('tab', { name: tabName })
      await user.click(tab)
      expect(tab).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('heading', { name: headingName })).toBeVisible()
    }

    await user.click(screen.getByRole('button', { name: 'Logout' }))
    expect(await screen.findByRole('heading', { name: 'Dental Inventory System' })).toBeVisible()
    expect(screen.getByLabelText('Username')).toBeVisible()
    expect(screen.getByLabelText('Password')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    expect(logout).toHaveBeenCalledOnce()
  })
})
