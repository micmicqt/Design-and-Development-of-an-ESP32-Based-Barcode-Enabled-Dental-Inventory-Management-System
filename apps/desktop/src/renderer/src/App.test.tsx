import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopApi,
  HardwareStatusDto,
  HardwareTransactionEvent,
  HardwareTransactionReceipt,
  InventoryCategory,
  MovementHistoryDto,
  ProductDto,
  ProductListQuery
} from '../../shared/ipc-contract'
import { App } from './App'

const PRODUCT_DATES = {
  createdAt: '2026-08-31T01:00:00.000Z',
  updatedAt: '2026-08-31T01:00:00.000Z'
}

function product(overrides: Partial<ProductDto> = {}): ProductDto {
  return {
    id: 1,
    barcode: '00012345',
    itemName: 'Composite Resin',
    category: 'Restorative & Esthetic',
    imageUrl: null,
    currentStock: 12,
    lowStockThreshold: 5,
    status: 'HIGH',
    ...PRODUCT_DATES,
    ...overrides
  }
}

function installDesktopApi(api: DesktopApi): void {
  Object.defineProperty(window, 'desktopApi', {
    configurable: true,
    value: api
  })
}

function createDesktopApi({
  authenticated = true,
  inventory = {},
  hardware = {}
}: {
  authenticated?: boolean
  inventory?: Partial<DesktopApi['inventory']>
  hardware?: Partial<DesktopApi['hardware']>
} = {}): DesktopApi {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue(
        authenticated
          ? { authenticated: true, username: 'admin' }
          : { authenticated: false, username: null }
      ),
      login: vi.fn().mockResolvedValue({
        ok: false,
        message: 'Access Denied',
        session: { authenticated: false, username: null }
      }),
      logout: vi.fn().mockResolvedValue({ authenticated: false, username: null })
    },
    inventory: {
      listProducts: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      findProductByBarcode: vi.fn().mockResolvedValue({ ok: true, value: null }),
      createProduct: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      updateProduct: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      deleteProduct: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      selectImage: vi.fn().mockResolvedValue({ ok: true, value: null }),
      selectDroppedImage: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'IMAGE_UNAVAILABLE', message: 'Not configured for this test.' }
      }),
      listMovementHistory: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      ...inventory
    },
    hardware: {
      sendDesktopHeartbeat: vi.fn().mockResolvedValue(true),
      getStatus: vi.fn().mockResolvedValue({
        connection: 'OFFLINE',
        device: null,
        mode: null,
        rtc: null,
        sd: null
      }),
      getNextTransactionEvent: vi.fn().mockResolvedValue(null),
      acknowledgeTransactionEvent: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      getTransactionReceipt: vi.fn().mockResolvedValue({ ok: true, value: null }),
      processTransaction: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      retryTransactionResultDelivery: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      retryTransactionAcknowledgement: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Not configured for this test.' }
      }),
      ...hardware
    }
  }
}

describe('Phase 6 Step 1 desktop presence heartbeat', () => {
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  async function advance(milliseconds: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds)
    })
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends immediately and approximately every four seconds while the authenticated shell is active', async () => {
    const sendDesktopHeartbeat = vi.fn().mockResolvedValue(true)
    installDesktopApi(createDesktopApi({ hardware: { sendDesktopHeartbeat } }))
    const view = render(<App />)

    await settle()
    expect(sendDesktopHeartbeat).toHaveBeenCalledOnce()

    await advance(3_999)
    expect(sendDesktopHeartbeat).toHaveBeenCalledOnce()
    await advance(1)
    expect(sendDesktopHeartbeat).toHaveBeenCalledTimes(2)

    await advance(4_000)
    expect(sendDesktopHeartbeat).toHaveBeenCalledTimes(3)
    view.unmount()
  })

  it('shares one in-flight heartbeat during StrictMode replay and never overlaps a slow request', async () => {
    let completeFirstHeartbeat!: (value: boolean) => void
    const firstHeartbeat = new Promise<boolean>((resolve) => {
      completeFirstHeartbeat = resolve
    })
    const sendDesktopHeartbeat = vi.fn().mockReturnValue(firstHeartbeat)
    installDesktopApi(createDesktopApi({ hardware: { sendDesktopHeartbeat } }))
    const view = render(<StrictMode><App /></StrictMode>)

    await settle()
    await advance(12_000)
    expect(sendDesktopHeartbeat).toHaveBeenCalledOnce()

    await act(async () => completeFirstHeartbeat(true))
    await advance(0)
    expect(sendDesktopHeartbeat).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('treats transport failure as harmless and automatically retries', async () => {
    const sendDesktopHeartbeat = vi.fn()
      .mockRejectedValueOnce(new Error('ESP32 unavailable'))
      .mockResolvedValue(true)
    installDesktopApi(createDesktopApi({ hardware: { sendDesktopHeartbeat } }))
    const view = render(<App />)

    await settle()
    expect(sendDesktopHeartbeat).toHaveBeenCalledOnce()
    expect(screen.getByRole('heading', { name: 'Item Inventory' })).toBeVisible()

    await advance(4_000)
    expect(sendDesktopHeartbeat).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { name: 'Item Inventory' })).toBeVisible()
    view.unmount()
  })

  it.each(['logout', 'unmount'] as const)(
    'stops scheduling heartbeats after shell %s',
    async (cleanupMethod) => {
      const sendDesktopHeartbeat = vi.fn().mockResolvedValue(true)
      const api = createDesktopApi({ hardware: { sendDesktopHeartbeat } })
      installDesktopApi(api)
      const view = render(<App />)
      await settle()
      expect(sendDesktopHeartbeat).toHaveBeenCalledOnce()

      if (cleanupMethod === 'logout') {
        fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
        await settle()
        expect(api.auth.logout).toHaveBeenCalledOnce()
        expect(screen.getByRole('button', { name: 'Sign In' })).toBeVisible()
      } else {
        view.unmount()
      }

      await advance(12_000)
      expect(sendDesktopHeartbeat).toHaveBeenCalledOnce()
    }
  )

  it('does not announce desktop presence before administrator login', async () => {
    const sendDesktopHeartbeat = vi.fn().mockResolvedValue(true)
    installDesktopApi(createDesktopApi({
      authenticated: false,
      hardware: { sendDesktopHeartbeat }
    }))
    const view = render(<App />)

    await settle()
    await advance(12_000)
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeVisible()
    expect(sendDesktopHeartbeat).not.toHaveBeenCalled()
    view.unmount()
  })
})

function filteredProductList(products: () => ProductDto[]) {
  return vi.fn(async (query: ProductListQuery) => {
    const search = query.search.toLocaleLowerCase()
    return {
      ok: true as const,
      value: products().filter(
        (item) =>
          (query.category === null || item.category === query.category) &&
          (search.length === 0 ||
            item.itemName.toLocaleLowerCase().includes(search) ||
            item.barcode.toLocaleLowerCase().includes(search))
      )
    }
  })
}

async function openAddItem(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('tab', { name: 'ADD NEW ITEM' }))
  expect(screen.getByRole('heading', { name: 'Add New Item' })).toBeVisible()
}

async function completeRequiredAddFields(
  user: ReturnType<typeof userEvent.setup>,
  values: {
    barcode?: string
    itemName?: string
    category?: InventoryCategory
    stock?: string
    threshold?: string
  } = {}
): Promise<void> {
  await user.type(screen.getByLabelText('Barcode / SKU'), values.barcode ?? '00012345')
  await user.type(screen.getByLabelText('Item Name'), values.itemName ?? 'Composite Resin')
  await user.selectOptions(
    screen.getByLabelText('Category'),
    values.category ?? 'Restorative & Esthetic'
  )
  await user.clear(screen.getByLabelText('Initial Stock'))
  await user.type(screen.getByLabelText('Initial Stock'), values.stock ?? '12')
  await user.clear(screen.getByLabelText('Low Stock Threshold'))
  await user.type(screen.getByLabelText('Low Stock Threshold'), values.threshold ?? '5')
}

describe('Phase 4 hardware transaction event delivery', () => {
  const restockEvent: HardwareTransactionEvent = {
    eventId: 'device-boot-0001',
    mode: 'restock',
    barcode: '0001234500123',
    timestamp: '2026-09-04 12:34:56'
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
    })
  }

  async function advance(milliseconds: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds)
    })
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['restock', 'checkout'] as const)(
    'shows one unknown %s scan with unchanged barcode and timestamp, and rejects only explicitly',
    async (mode) => {
      const event = { ...restockEvent, mode }
      const getNextTransactionEvent = vi.fn().mockResolvedValue(event)
      const acknowledgeTransactionEvent = vi.fn().mockImplementation(async () => {
        getNextTransactionEvent.mockResolvedValue(null)
        return { ok: true, value: { eventId: event.eventId } }
      })
      const api = createDesktopApi({
        hardware: { getNextTransactionEvent, acknowledgeTransactionEvent }
      })
      installDesktopApi(api)

      render(<App />)
      await settle()
      const dialog = screen.getByRole('dialog', { name: `${mode.toUpperCase()} TRANSACTION` })
      expect(within(dialog).getByText('0001234500123')).toBeVisible()
      expect(within(dialog).getByText('2026-09-04 12:34:56')).toBeVisible()
      expect(within(dialog).getAllByRole('button')).toHaveLength(2)
      expect(within(dialog).getByRole('heading', { name: 'ITEM NOT FOUND' })).toBeVisible()
      expect(api.inventory.findProductByBarcode).toHaveBeenCalledWith(event.barcode)
      expect(within(dialog).queryByRole('spinbutton')).not.toBeInTheDocument()

      // The same FIFO head would be returned again, but polling pauses while it is pending.
      await advance(10_000)
      expect(getNextTransactionEvent).toHaveBeenCalledOnce()
      expect(screen.getAllByRole('dialog')).toHaveLength(1)
      expect(acknowledgeTransactionEvent).not.toHaveBeenCalled()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Reject scan' }))
      await settle()
      expect(acknowledgeTransactionEvent).toHaveBeenCalledWith(event.eventId)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(getNextTransactionEvent).toHaveBeenCalledTimes(2)
      expect(api.inventory.createProduct).not.toHaveBeenCalled()
      expect(api.inventory.updateProduct).not.toHaveBeenCalled()
      expect(api.inventory.deleteProduct).not.toHaveBeenCalled()
      expect(api.inventory.listMovementHistory).not.toHaveBeenCalled()
    }
  )

  it('polls empty results once per second and cancels its timer on unmount', async () => {
    const getNextTransactionEvent = vi.fn().mockResolvedValue(null)
    installDesktopApi(createDesktopApi({ hardware: { getNextTransactionEvent } }))
    const view = render(<App />)
    await settle()
    expect(getNextTransactionEvent).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await advance(999)
    expect(getNextTransactionEvent).toHaveBeenCalledOnce()
    await advance(1)
    expect(getNextTransactionEvent).toHaveBeenCalledTimes(2)
    view.unmount()
    await advance(5_000)
    expect(getNextTransactionEvent).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight poll during StrictMode replay and never overlaps slow requests', async () => {
    let resolveEvent!: (event: HardwareTransactionEvent | null) => void
    const getNextTransactionEvent = vi.fn().mockReturnValue(
      new Promise<HardwareTransactionEvent | null>((resolve) => {
        resolveEvent = resolve
      })
    )
    installDesktopApi(createDesktopApi({ hardware: { getNextTransactionEvent } }))
    render(<StrictMode><App /></StrictMode>)
    await settle()
    await advance(10_000)
    expect(getNextTransactionEvent).toHaveBeenCalledOnce()

    await act(async () => resolveEvent(restockEvent))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog', { name: 'RESTOCK TRANSACTION' })).toBeVisible()
    await advance(10_000)
    expect(getNextTransactionEvent).toHaveBeenCalledOnce()
  })

  it('retries after transport failure while inventory navigation remains usable', async () => {
    const getNextTransactionEvent = vi.fn()
      .mockRejectedValueOnce(new Error('ESP32 unavailable'))
      .mockResolvedValueOnce(null)
      .mockResolvedValue(restockEvent)
    installDesktopApi(createDesktopApi({ hardware: { getNextTransactionEvent } }))
    render(<App />)
    await settle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Search inventory')).toBeEnabled()
    expect(screen.getByLabelText('Filter by category')).toBeEnabled()
    fireEvent.click(screen.getByRole('tab', { name: 'MOVEMENT HISTORY' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Movement History' })).toBeVisible()

    await advance(1_000)
    expect(getNextTransactionEvent).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await advance(1_000)
    expect(getNextTransactionEvent).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('dialog', { name: 'RESTOCK TRANSACTION' })).toBeVisible()
  })

  it('keeps the modal for rejected, failed, or mismatched acknowledgements and allows retry', async () => {
    const checkoutEvent: HardwareTransactionEvent = {
      ...restockEvent, eventId: 'device-boot-0002', mode: 'checkout'
    }
    const getNextTransactionEvent = vi.fn()
      .mockResolvedValueOnce(restockEvent)
      .mockResolvedValue(checkoutEvent)
    const acknowledgeTransactionEvent = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Offline' } })
      .mockRejectedValueOnce(new Error('Disconnected during ACK'))
      .mockResolvedValueOnce({ ok: true, value: { eventId: 'wrong-event' } })
      .mockResolvedValueOnce({ ok: true, value: { eventId: restockEvent.eventId } })
    installDesktopApi(createDesktopApi({
      hardware: { getNextTransactionEvent, acknowledgeTransactionEvent }
    }))
    render(<App />)
    await settle()

    const expectedMessages = [
      'Offline',
      'Could not acknowledge this scan. Check the ESP32 connection and try again.',
      'Could not acknowledge this scan. Check the ESP32 connection and try again.'
    ]
    for (const [index, expectedMessage] of expectedMessages.entries()) {
      const attempt = index + 1
      fireEvent.click(screen.getByRole('button', { name: 'Reject scan' }))
      await settle()
      const dialog = screen.getByRole('dialog', { name: 'RESTOCK TRANSACTION' })
      expect(within(dialog).getByText(expectedMessage, {
        selector: '[role="alert"]'
      })).toBeVisible()
      expect(dialog).toBeVisible()
      expect(screen.getByRole('button', { name: 'Reject scan' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Reject scan' })).toHaveFocus()
      await advance(2_000)
      expect(getNextTransactionEvent).toHaveBeenCalledOnce()
      expect(acknowledgeTransactionEvent).toHaveBeenCalledTimes(attempt)
    }

    fireEvent.click(screen.getByRole('button', { name: 'Reject scan' }))
    await settle()
    expect(screen.queryByRole('dialog', { name: 'RESTOCK TRANSACTION' })).not.toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'CHECKOUT TRANSACTION' })).toBeVisible()
    expect(screen.queryByText('Could not acknowledge this scan. Check the ESP32 connection and try again.')).not.toBeInTheDocument()
    expect(getNextTransactionEvent).toHaveBeenCalledTimes(2)
    expect(acknowledgeTransactionEvent).toHaveBeenCalledTimes(4)
  })

  it('does not dismiss or issue another ACK while acknowledgement is outstanding', async () => {
    let completeAcknowledgement!: (value: { ok: true; value: { eventId: string } }) => void
    const acknowledgeTransactionEvent = vi.fn().mockReturnValue(
      new Promise((resolve) => { completeAcknowledgement = resolve })
    )
    const getNextTransactionEvent = vi.fn()
      .mockResolvedValueOnce(restockEvent)
      .mockResolvedValue(null)
    installDesktopApi(createDesktopApi({
      hardware: { getNextTransactionEvent, acknowledgeTransactionEvent }
    }))
    render(<App />)
    await settle()

    const dismiss = screen.getByRole('button', { name: 'Reject scan' })
    fireEvent.click(dismiss)
    fireEvent.click(dismiss)
    expect(screen.getByRole('button', { name: 'Acknowledging…' })).toBeDisabled()
    await advance(5_000)
    expect(acknowledgeTransactionEvent).toHaveBeenCalledOnce()
    expect(getNextTransactionEvent).toHaveBeenCalledOnce()
    expect(screen.getByRole('dialog')).toBeVisible()

    await act(async () => completeAcknowledgement({
      ok: true, value: { eventId: restockEvent.eventId }
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getNextTransactionEvent).toHaveBeenCalledTimes(2)
  })

  it('contains keyboard focus while pending and restores the previous control only after ACK', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    let resolveEvent!: (event: HardwareTransactionEvent) => void
    const getNextTransactionEvent = vi.fn()
      .mockReturnValueOnce(new Promise((resolve) => { resolveEvent = resolve }))
      .mockResolvedValue(null)
    let completeAcknowledgement!: (value: { ok: true; value: { eventId: string } }) => void
    const acknowledgeTransactionEvent = vi.fn().mockReturnValue(
      new Promise((resolve) => { completeAcknowledgement = resolve })
    )
    const api = createDesktopApi({
      hardware: { getNextTransactionEvent, acknowledgeTransactionEvent }
    })
    installDesktopApi(api)
    render(<App />)
    await settle()
    const search = screen.getByLabelText('Search inventory')
    search.focus()
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' })
    const logout = screen.getByRole('button', { name: 'Logout' })

    await act(async () => resolveEvent(restockEvent))
    const dialog = screen.getByRole('dialog', { name: 'RESTOCK TRANSACTION' })
    const dismiss = within(dialog).getByRole('button', { name: 'Reject scan' })
    expect(dismiss).toHaveFocus()
    // JSDOM does not enforce native inert behavior: assert the browser containment contract,
    // and separately exercise the dialog's actual Tab/Shift+Tab handling with userEvent.
    expect(navigation.closest('.sidebar')).toHaveAttribute('inert')
    expect(logout.closest('.workspace')).toHaveAttribute('inert')
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Review later' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(dismiss).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(dialog).toBeVisible()
    expect(acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(api.auth.logout).not.toHaveBeenCalled()

    fireEvent.click(dismiss)
    expect(dialog).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Acknowledging…' })).toBeDisabled()
    await user.tab()
    expect(dialog).toHaveFocus()
    await user.tab({ shift: true })
    expect(dialog).toHaveFocus()
    expect(logout.closest('.workspace')).toHaveAttribute('inert')

    await act(async () => completeAcknowledgement({
      ok: true, value: { eventId: restockEvent.eventId }
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(search).toHaveFocus()
    expect(navigation.closest('.sidebar')).not.toHaveAttribute('inert')
    expect(logout.closest('.workspace')).not.toHaveAttribute('inert')
    expect(api.inventory.updateProduct).not.toHaveBeenCalled()
    expect(api.auth.logout).not.toHaveBeenCalled()
  })

  it.each(['logout', 'unmount'] as const)(
    'ignores a late in-flight event after %s without acknowledging or resuming polling',
    async (cleanupMethod) => {
      let resolveEvent!: (event: HardwareTransactionEvent) => void
      const getNextTransactionEvent = vi.fn().mockReturnValue(
        new Promise((resolve) => { resolveEvent = resolve })
      )
      const api = createDesktopApi({ hardware: { getNextTransactionEvent } })
      installDesktopApi(api)
      const view = render(<App />)
      await settle()

      if (cleanupMethod === 'logout') {
        fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
        await settle()
        expect(screen.getByRole('button', { name: 'Sign In' })).toBeVisible()
      } else {
        view.unmount()
      }

      await act(async () => resolveEvent(restockEvent))
      await advance(5_000)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(getNextTransactionEvent).toHaveBeenCalledOnce()
      expect(api.hardware.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    }
  )

  it('does not poll hardware events before administrator login', async () => {
    const api = createDesktopApi({ authenticated: false })
    installDesktopApi(api)
    render(<App />)
    await settle()
    await advance(5_000)
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeVisible()
    expect(api.hardware.getNextTransactionEvent).not.toHaveBeenCalled()
  })
})

describe('Phase 5 Step 2 hardware inventory transaction', () => {
  const event: HardwareTransactionEvent = {
    eventId: 'device-phase5-0001', mode: 'restock', barcode: '00012345',
    timestamp: '2026-09-04 12:34:56'
  }

  function receipt(
    overrides: Partial<HardwareTransactionReceipt> = {}
  ): HardwareTransactionReceipt {
    return {
      ...event,
      transactionId: 'online-device-phase5-0001',
      productId: 1,
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      quantity: 3,
      previousStock: 12,
      newTotal: 15,
      status: 'HIGH',
      resultDeliveredToHardware: true,
      ...overrides
    }
  }

  async function settle(): Promise<void> {
    await act(async () => {
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
    })
  }

  function installKnownItem(mode: HardwareTransactionEvent['mode'] = 'restock') {
    const scannedEvent = { ...event, mode }
    const committedReceipt = receipt({
      mode,
      newTotal: mode === 'restock' ? 15 : 9
    })
    const getNextTransactionEvent = vi.fn()
      .mockResolvedValueOnce(scannedEvent)
      .mockResolvedValue(null)
    const api = createDesktopApi({
      inventory: {
        findProductByBarcode: vi.fn().mockResolvedValue({ ok: true, value: product({
          imageUrl: 'dental-image://product/00000000-0000-4000-8000-000000000001.jpg'
        }) })
      },
      hardware: {
        getNextTransactionEvent,
        processTransaction: vi.fn().mockResolvedValue({
          ok: true,
          value: { receipt: committedReceipt, acknowledged: true }
        }),
        retryTransactionAcknowledgement: vi.fn().mockResolvedValue({
          ok: true,
          value: { receipt: committedReceipt, acknowledged: true }
        })
      }
    })
    installDesktopApi(api)
    return api
  }

  function expectNoWritesOrAcknowledgement(api: DesktopApi): void {
    expect(api.inventory.createProduct).not.toHaveBeenCalled()
    expect(api.inventory.updateProduct).not.toHaveBeenCalled()
    expect(api.inventory.deleteProduct).not.toHaveBeenCalled()
    expect(api.hardware.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['restock', 'checkout'] as const)('populates %s from exact lookup and completes through the atomic backend action', async (mode) => {
    const api = installKnownItem(mode)
    render(<App />)
    await settle()
    const dialog = screen.getByRole('dialog', { name: `${mode.toUpperCase()} TRANSACTION` })
    expect(api.inventory.findProductByBarcode).toHaveBeenCalledWith('00012345')
    expect(within(dialog).getByRole('heading', { name: 'Composite Resin' })).toBeVisible()
    expect(within(dialog).getByText('Restorative & Esthetic')).toBeVisible()
    expect(within(dialog).getByText('00012345')).toBeVisible()
    expect(within(dialog).getByText('2026-09-04 12:34:56')).toBeVisible()
    expect(within(dialog).getByText('12')).toBeVisible()
    expect(within(dialog).getByText('HIGH')).toBeVisible()
    expect(within(dialog).getByRole('img', { name: 'Composite Resin reference' })).toHaveAttribute(
      'src', 'dental-image://product/00000000-0000-4000-8000-000000000001.jpg'
    )
    const quantity = within(dialog).getByLabelText(`Quantity to ${mode === 'restock' ? 'ADD' : 'REMOVE'}`)
    expect(quantity).toHaveFocus()
    expectNoWritesOrAcknowledgement(api)
    fireEvent.change(quantity, { target: { value: '3' } })
    fireEvent.click(within(dialog).getByRole('button', {
      name: mode === 'restock' ? 'Confirm Restock' : 'Confirm Checkout'
    }))
    await settle()
    expect(api.hardware.processTransaction).toHaveBeenCalledWith({
      eventId: event.eventId,
      quantity: 3
    })
    expect(api.hardware.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(
      `Composite Resin: ${mode.toUpperCase()} saved. New stock ${mode === 'restock' ? '15' : '9'} (HIGH).`
    )).toBeVisible()
    expect(api.inventory.updateProduct).not.toHaveBeenCalled()
  }, 15_000)

  it.each([
    ['', 'Enter a quantity.'],
    ['0', 'Quantity must be greater than zero.'],
    ['-1', 'Quantity must be a positive whole number.'],
    ['1.5', 'Quantity must be a positive whole number.'],
    ['abc', 'Quantity must be a positive whole number.'],
    ['10001', 'Quantity must not exceed 10,000 per scan.']
  ])('rejects quantity %j and preserves the pending event', async (value, errorMessage) => {
    const api = installKnownItem()
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(errorMessage)
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()
    expectNoWritesOrAcknowledgement(api)
  })

  it('shows backend checkout rejection when stock changed after the dialog snapshot', async () => {
    const api = installKnownItem('checkout')
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Insufficient stock. Only 2 available for checkout.'
      }
    })
    render(<App />)
    await settle()
    expect(within(screen.getByRole('dialog')).getByText('12')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Quantity to REMOVE'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Checkout' }))
    await settle()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Insufficient stock. Only 2 available for checkout.')
    expect(api.hardware.processTransaction).toHaveBeenCalledWith({
      eventId: event.eventId,
      quantity: 3
    })
    expect(api.hardware.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Confirm Checkout' })).toBeEnabled()
  })

  it('clearly blocks checkout when current stock is zero', async () => {
    const api = installKnownItem('checkout')
    vi.mocked(api.inventory.findProductByBarcode).mockResolvedValue({
      ok: true, value: product({ currentStock: 0, status: 'EMPTY' })
    })
    render(<App />)
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('Checkout cannot proceed: this item has no available stock.')
    fireEvent.change(screen.getByLabelText('Quantity to REMOVE'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Checkout' }))
    await settle()
    expect(screen.getAllByRole('alert').every((alert) => alert.textContent?.includes('no available stock'))).toBe(true)
    expectNoWritesOrAcknowledgement(api)
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()
  })

  it('cancels a zero-stock checkout explicitly without changing inventory or history', async () => {
    const api = installKnownItem('checkout')
    vi.mocked(api.inventory.findProductByBarcode).mockResolvedValue({
      ok: true, value: product({ currentStock: 0, status: 'EMPTY' })
    })
    vi.mocked(api.hardware.acknowledgeTransactionEvent).mockResolvedValue({
      ok: true, value: { eventId: event.eventId }
    })
    render(<App />)
    await settle()

    expect(screen.getByLabelText('Quantity to REMOVE')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm Checkout' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }))
    await settle()

    expect(api.hardware.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()
    expect(api.inventory.createProduct).not.toHaveBeenCalled()
    expect(api.inventory.updateProduct).not.toHaveBeenCalled()
    expect(api.inventory.deleteProduct).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows a backend cancellation error, keeps the scan open, and allows retry', async () => {
    const api = installKnownItem('checkout')
    vi.mocked(api.hardware.acknowledgeTransactionEvent)
      .mockResolvedValueOnce({
        ok: false, error: {
          code: 'VALIDATION_ERROR',
          message: 'A different hardware scan is currently pending.'
        }
      })
      .mockResolvedValueOnce({ ok: true, value: { eventId: event.eventId } })
    render(<App />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }))
    await settle()

    expect(screen.getByRole('dialog', { name: 'CHECKOUT TRANSACTION' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A different hardware scan is currently pending.'
    )
    expect(screen.queryByText(
      'Could not cancel this scan. Check the ESP32 connection and try again.'
    )).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toBeEnabled()
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }))
    await settle()

    expect(api.hardware.acknowledgeTransactionEvent).toHaveBeenCalledTimes(2)
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('deduplicates known-scan cancellation while acknowledgement is in flight', async () => {
    let completeCancellation!: (value: { ok: true; value: { eventId: string } }) => void
    const api = installKnownItem()
    vi.mocked(api.hardware.acknowledgeTransactionEvent).mockReturnValue(
      new Promise((resolve) => { completeCancellation = resolve })
    )
    render(<App />)
    await settle()

    const cancel = screen.getByRole('button', { name: 'Cancel scan' })
    fireEvent.click(cancel)
    fireEvent.click(cancel)

    expect(api.hardware.acknowledgeTransactionEvent).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review later' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm Restock' })).toBeDisabled()
    expect(screen.getByLabelText('Quantity to ADD')).toBeDisabled()
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()

    await act(async () => completeCancellation({
      ok: true, value: { eventId: event.eventId }
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('supports Review later and resumes with fresh data without clearing or acknowledging the scan', async () => {
    const api = installKnownItem()
    vi.mocked(api.inventory.findProductByBarcode)
      .mockResolvedValueOnce({ ok: true, value: product() })
      .mockResolvedValueOnce({ ok: true, value: product({ itemName: 'Updated Item', currentStock: 7 }) })
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review later' }))
    await settle()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('A RESTOCK scan is pending. Resume to continue safely.')).toBeVisible()
    expect(screen.getByLabelText('Search inventory')).toBeEnabled()
    expect(screen.getByLabelText('Filter by category')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: '00012345' } })
    fireEvent.change(screen.getByLabelText('Filter by category'), { target: { value: 'General' } })
    fireEvent.click(screen.getByRole('tab', { name: 'MOVEMENT HISTORY' }))
    await settle()
    expect(screen.getByRole('heading', { name: 'Movement History' })).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.hardware.getNextTransactionEvent).toHaveBeenCalledOnce()
    expectNoWritesOrAcknowledgement(api)

    fireEvent.click(screen.getByRole('button', { name: 'Resume pending scan' }))
    await settle()
    expect(api.inventory.findProductByBarcode).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: 'Updated Item' })).toBeVisible()
    expect(within(screen.getByRole('dialog')).getByText('7')).toBeVisible()
    expect(screen.getByLabelText('Quantity to ADD')).toHaveValue('2')
    expectNoWritesOrAcknowledgement(api)
  })

  it('serializes lookup when a loading scan is reviewed later and resumed before its response', async () => {
    let finishFirstLookup!: (result: { ok: true; value: ProductDto }) => void
    const api = installKnownItem()
    vi.mocked(api.inventory.findProductByBarcode)
      .mockReturnValueOnce(new Promise((resolve) => { finishFirstLookup = resolve }))
      .mockResolvedValueOnce({ ok: true, value: product({ itemName: 'Fresh Item', currentStock: 4 }) })
    render(<App />)
    await settle()
    expect(screen.getByText('Looking up barcode in inventory…')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Review later' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Resume pending scan' }))
    await settle()
    expect(api.inventory.findProductByBarcode).toHaveBeenCalledOnce()
    await act(async () => finishFirstLookup({ ok: true, value: product() }))
    expect(api.inventory.findProductByBarcode).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('dialog')).getByText('Fresh Item')).toBeVisible()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expectNoWritesOrAcknowledgement(api)
  })

  it.each(['rejected promise', 'error result'] as const)('does not classify %s as an unknown barcode and supports retry', async (failure) => {
    const api = installKnownItem()
    const lookup = vi.mocked(api.inventory.findProductByBarcode)
    if (failure === 'rejected promise') lookup.mockRejectedValueOnce(new Error('Database temporarily unavailable'))
    else lookup.mockResolvedValueOnce({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Unavailable' } })
    render(<App />)
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not look up this barcode.')
    expect(screen.queryByText('ITEM NOT FOUND')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject scan' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review later' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry lookup' }))
    await settle()
    expect(screen.getByLabelText('Quantity to ADD')).toBeVisible()
    expectNoWritesOrAcknowledgement(api)
  })

  it('keeps a scan pending when the backend reports that its item was removed', async () => {
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'This barcode is no longer registered.' }
    })
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('This barcode is no longer registered.')
    expect(screen.getByRole('button', { name: 'Confirm Restock' })).toBeEnabled()
    expect(api.hardware.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('allows only one backend transaction while confirmation is outstanding', async () => {
    let finishTransaction!: (result: {
      ok: true
      value: { receipt: HardwareTransactionReceipt; acknowledged: boolean }
    }) => void
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction).mockReturnValueOnce(
      new Promise((resolve) => { finishTransaction = resolve })
    )
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    const confirmButton = screen.getByRole('button', { name: 'Confirm Restock' })
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    await settle()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Processing…' })).toBeDisabled()
    expect(screen.getByLabelText('Quantity to ADD')).toBeDisabled()
    await act(async () => finishTransaction({
      ok: true,
      value: { receipt: receipt({ quantity: 2, newTotal: 14 }), acknowledged: false }
    }))
    expect(screen.getByText('Inventory transaction saved')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry acknowledgement' })).toBeEnabled()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
  })

  it('locks a committed transaction to result-delivery retry without resubmitting stock', async () => {
    const resultPendingReceipt = receipt({
      quantity: 2,
      newTotal: 14,
      resultDeliveredToHardware: false
    })
    const deliveredReceipt = receipt({
      quantity: 2,
      newTotal: 14,
      resultDeliveredToHardware: true
    })
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: true,
      value: { receipt: resultPendingReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionResultDelivery).mockResolvedValueOnce({
      ok: true,
      value: { receipt: deliveredReceipt, acknowledged: true }
    })
    render(<App />)
    await settle()

    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    expect(screen.getByText('Inventory transaction saved')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Inventory was updated, but the transaction result has not reached the ESP32.'
    )
    expect(screen.getByRole('button', { name: 'Retry result delivery' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry acknowledgement' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry result delivery' }))
    await settle()

    expect(api.hardware.retryTransactionResultDelivery).toHaveBeenCalledOnce()
    expect(api.hardware.retryTransactionResultDelivery).toHaveBeenCalledWith(event.eventId)
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
    expect(api.hardware.retryTransactionAcknowledgement).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('moves from result-delivery recovery to acknowledgement-only recovery', async () => {
    const resultPendingReceipt = receipt({ resultDeliveredToHardware: false })
    const deliveredReceipt = receipt({ resultDeliveredToHardware: true })
    const api = installKnownItem()
    vi.mocked(api.hardware.getTransactionReceipt)
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValue({ ok: true, value: deliveredReceipt })
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: true,
      value: { receipt: resultPendingReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionResultDelivery).mockResolvedValueOnce({
      ok: true,
      value: { receipt: deliveredReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionAcknowledgement).mockResolvedValueOnce({
      ok: true,
      value: { receipt: deliveredReceipt, acknowledged: true }
    })
    render(<App />)
    await settle()

    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry result delivery' }))
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Inventory was updated, but the ESP32 has not acknowledged this transaction.'
    )
    expect(screen.getByRole('button', { name: 'Retry acknowledgement' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Retry result delivery' })).not.toBeInTheDocument()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Review later' }))
    expect(screen.getByText(
      'The RESTOCK transaction was saved. ESP32 acknowledgement is pending.'
    )).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Resume pending scan' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry acknowledgement' }))
    await settle()
    expect(api.hardware.retryTransactionAcknowledgement).toHaveBeenCalledOnce()
    expect(api.hardware.retryTransactionResultDelivery).toHaveBeenCalledOnce()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps the committed receipt locked when result-delivery retry fails', async () => {
    const resultPendingReceipt = receipt({ resultDeliveredToHardware: false })
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: true,
      value: { receipt: resultPendingReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionResultDelivery).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'ESP32 unavailable.' }
    })
    render(<App />)
    await settle()

    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Retry result delivery' }))
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Inventory was updated, but the transaction result has not reached the ESP32.'
    )
    expect(screen.getByRole('button', { name: 'Retry result delivery' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
    expect(api.hardware.retryTransactionResultDelivery).toHaveBeenCalledOnce()
    expect(api.hardware.retryTransactionAcknowledgement).not.toHaveBeenCalled()
  })

  it('deduplicates result-delivery retries while one retry is outstanding', async () => {
    let finishResultDelivery!: (result: {
      ok: true
      value: { receipt: HardwareTransactionReceipt; acknowledged: boolean }
    }) => void
    const resultPendingReceipt = receipt({ resultDeliveredToHardware: false })
    const deliveredReceipt = receipt({ resultDeliveredToHardware: true })
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: true,
      value: { receipt: resultPendingReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionResultDelivery).mockReturnValueOnce(
      new Promise((resolve) => { finishResultDelivery = resolve })
    )
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    const retry = screen.getByRole('button', { name: 'Retry result delivery' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled()
    expect(api.hardware.retryTransactionResultDelivery).toHaveBeenCalledOnce()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()

    await act(async () => finishResultDelivery({
      ok: true,
      value: { receipt: deliveredReceipt, acknowledged: true }
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('recovers result-delivery state after restart and preserves it through Review later', async () => {
    const resultPendingReceipt = receipt({
      quantity: 4,
      previousStock: 8,
      newTotal: 12,
      resultDeliveredToHardware: false
    })
    const api = installKnownItem()
    vi.mocked(api.hardware.getTransactionReceipt).mockResolvedValue({
      ok: true,
      value: resultPendingReceipt
    })
    render(<App />)
    await settle()

    expect(screen.getByText('Inventory transaction saved')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry result delivery' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    expect(api.inventory.findProductByBarcode).not.toHaveBeenCalled()
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Review later' }))
    expect(screen.getByText(
      'The RESTOCK transaction was saved. ESP32 stock feedback is pending.'
    )).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Resume pending scan' }))
    await settle()
    expect(screen.getByRole('button', { name: 'Retry result delivery' })).toBeEnabled()
    expect(api.inventory.findProductByBarcode).not.toHaveBeenCalled()
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()
  })

  it('keeps a database failure pending without acknowledgement and permits a safe retry', async () => {
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'The inventory transaction could not be saved.' }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { receipt: receipt({ quantity: 2, newTotal: 14 }), acknowledged: true }
      })
    render(<App />)
    await settle()

    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The inventory transaction could not be saved.'
    )
    expect(screen.getByRole('button', { name: 'Confirm Restock' })).toBeEnabled()
    expect(api.hardware.getTransactionReceipt).toHaveBeenCalledTimes(2)
    expect(api.hardware.retryTransactionAcknowledgement).not.toHaveBeenCalled()
    expect(api.hardware.acknowledgeTransactionEvent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()
    expect(api.hardware.processTransaction).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('locks a committed transaction to acknowledgement-only recovery and preserves it through Review later', async () => {
    const committedReceipt = receipt({ quantity: 2, newTotal: 14, status: 'LOW' })
    const api = installKnownItem()
    vi.mocked(api.hardware.getTransactionReceipt)
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValue({ ok: true, value: committedReceipt })
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: true,
      value: { receipt: committedReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionAcknowledgement).mockResolvedValueOnce({
      ok: true,
      value: { receipt: committedReceipt, acknowledged: true }
    })
    render(<App />)
    await settle()

    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    const committedDialog = screen.getByRole('dialog')
    expect(within(committedDialog).getByText('Inventory transaction saved')).toBeVisible()
    expect(within(committedDialog).getByText('+2')).toBeVisible()
    expect(within(committedDialog).getByText('14')).toBeVisible()
    expect(within(committedDialog).getByText('LOW')).toBeVisible()
    expect(within(committedDialog).getByRole('alert')).toHaveTextContent(
      'Inventory was updated, but the ESP32 has not acknowledged this transaction.'
    )
    expect(within(committedDialog).queryByRole('button', { name: 'Confirm Restock' }))
      .not.toBeInTheDocument()
    expect(within(committedDialog).queryByLabelText('Quantity to ADD')).not.toBeInTheDocument()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()

    fireEvent.click(within(committedDialog).getByRole('button', { name: 'Review later' }))
    expect(screen.getByText(
      'The RESTOCK transaction was saved. ESP32 acknowledgement is pending.'
    )).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Resume pending scan' }))
    await settle()

    expect(api.hardware.getTransactionReceipt).toHaveBeenCalledTimes(2)
    expect(api.inventory.findProductByBarcode).toHaveBeenCalledOnce()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry acknowledgement' }))
    await settle()
    expect(api.hardware.retryTransactionAcknowledgement).toHaveBeenCalledOnce()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText(
      'Composite Resin: RESTOCK saved. New stock 14 (LOW).'
    )).toBeVisible()
  })

  it('deduplicates acknowledgement retries while one retry is outstanding', async () => {
    let finishAcknowledgement!: (result: {
      ok: true
      value: { receipt: HardwareTransactionReceipt; acknowledged: boolean }
    }) => void
    const committedReceipt = receipt({ quantity: 2, newTotal: 14 })
    const api = installKnownItem()
    vi.mocked(api.hardware.processTransaction).mockResolvedValueOnce({
      ok: true,
      value: { receipt: committedReceipt, acknowledged: false }
    })
    vi.mocked(api.hardware.retryTransactionAcknowledgement).mockReturnValueOnce(
      new Promise((resolve) => { finishAcknowledgement = resolve })
    )
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    const retry = screen.getByRole('button', { name: 'Retry acknowledgement' })
    fireEvent.click(retry)
    fireEvent.click(retry)
    expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled()
    expect(api.hardware.retryTransactionAcknowledgement).toHaveBeenCalledOnce()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()

    await act(async () => finishAcknowledgement({
      ok: true,
      value: { receipt: committedReceipt, acknowledged: true }
    }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('recovers a durable receipt before lookup after a desktop restart and offers ACK only', async () => {
    const committedReceipt = receipt({ quantity: 4, previousStock: 8, newTotal: 12 })
    const api = installKnownItem()
    vi.mocked(api.hardware.getTransactionReceipt).mockResolvedValue({
      ok: true,
      value: committedReceipt
    })
    render(<App />)
    await settle()

    expect(screen.getByText('Inventory transaction saved')).toBeVisible()
    expect(screen.getByText('+4')).toBeVisible()
    expect(screen.getByText('New stock').nextElementSibling).toHaveTextContent('12')
    expect(screen.getByRole('button', { name: 'Retry acknowledgement' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    expect(api.inventory.findProductByBarcode).not.toHaveBeenCalled()
    expect(api.hardware.processTransaction).not.toHaveBeenCalled()
  })

  it('recovers a committed receipt after an interrupted process response without allowing resubmission', async () => {
    const committedReceipt = receipt({ quantity: 2, newTotal: 14 })
    const api = installKnownItem()
    vi.mocked(api.hardware.getTransactionReceipt)
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockResolvedValueOnce({ ok: true, value: committedReceipt })
    vi.mocked(api.hardware.processTransaction).mockRejectedValueOnce(
      new Error('IPC response was interrupted after commit')
    )
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    expect(screen.getByText('Inventory transaction saved')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Inventory was updated, but the ESP32 has not acknowledged this transaction.'
    )
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry acknowledgement' })).toBeEnabled()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
  })

  it('locks ambiguous failures until the durable receipt check can be retried', async () => {
    const api = installKnownItem()
    vi.mocked(api.hardware.getTransactionReceipt)
      .mockResolvedValueOnce({ ok: true, value: null })
      .mockRejectedValueOnce(new Error('Database temporarily unavailable'))
      .mockResolvedValueOnce({ ok: true, value: null })
    vi.mocked(api.hardware.processTransaction).mockRejectedValueOnce(
      new Error('IPC response interrupted')
    )
    render(<App />)
    await settle()
    fireEvent.change(screen.getByLabelText('Quantity to ADD'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Restock' }))
    await settle()

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not verify whether this transaction was already saved.'
    )
    expect(screen.queryByRole('button', { name: 'Confirm Restock' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry transaction check' })).toBeEnabled()
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: 'Retry transaction check' }))
    await settle()
    expect(api.hardware.getTransactionReceipt).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('button', { name: 'Confirm Restock' })).toBeEnabled()
    expect(screen.getByLabelText('Quantity to ADD')).toHaveValue('2')
    expect(api.hardware.processTransaction).toHaveBeenCalledOnce()
  })

  it('keeps keyboard focus inside known-item controls and returns it to Resume pending scan', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    const api = installKnownItem()
    render(<App />)
    await settle()
    const dialog = screen.getByRole('dialog', { name: 'RESTOCK TRANSACTION' })
    const quantity = screen.getByLabelText('Quantity to ADD')
    const confirmButton = screen.getByRole('button', { name: 'Confirm Restock' })
    expect(quantity).toHaveFocus()
    await user.tab({ shift: true })
    expect(confirmButton).toHaveFocus()
    await user.tab()
    expect(quantity).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Cancel scan' })).toHaveFocus()
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Review later' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Review later' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const resume = screen.getByRole('button', { name: 'Resume pending scan' })
    await user.click(resume)
    await settle()
    expect(screen.getByLabelText('Quantity to ADD')).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Review later' }))
    expect(screen.getByRole('button', { name: 'Resume pending scan' })).toHaveFocus()
    expectNoWritesOrAcknowledgement(api)
  })
})

describe('Phase 2 desktop application', () => {
  beforeEach(() => {
    installDesktopApi(createDesktopApi({ authenticated: false }))
  })

  it('presents the exact Any Time Dental branding and supplied clinic imagery', async () => {
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: 'Dental Inventory Management System' })
    ).toBeVisible()
    expect(screen.getByText('Any Time Dental')).toBeVisible()
    expect(screen.getByText('STAFF PORTAL')).toBeVisible()
    expect(screen.getByText('Sign in to access and manage clinic inventory.')).toBeVisible()
    expect(screen.getByText('Authorized personnel only')).toBeVisible()

    const logo = screen.getByRole('img', { name: 'Any Time Dental clinic logo' })
    expect(logo).toBeVisible()
    expect(logo.getAttribute('src')).toContain('any-time-dental-logo.png')

    const clinicTeam = screen.getByLabelText('Any Time Dental clinic team')
    const staffPhotos = within(clinicTeam).getAllByRole('img')
    expect(staffPhotos).toHaveLength(3)
    expect(staffPhotos.map((photo) => photo.getAttribute('src'))).toEqual([
      expect.stringContaining('staff-01.jpg'),
      expect.stringContaining('staff-02.jpg'),
      expect.stringContaining('staff-03.jpg')
    ])
    expect(
      within(clinicTeam).getByRole('img', { name: 'Any Time Dental clinic team' })
    ).toHaveClass('staff-photo__image--uncropped')
    expect(
      within(clinicTeam).getByRole('img', {
        name: 'Any Time Dental dentist providing patient care'
      })
    ).not.toHaveClass('staff-photo__image--uncropped')
    expect(
      within(clinicTeam).getByRole('img', { name: 'Any Time Dental reception team' })
    ).not.toHaveClass('staff-photo__image--uncropped')
    expect(within(clinicTeam).getByText('READY FOR EVERY PATIENT')).toBeVisible()
    expect(within(clinicTeam).getByText('Smarter inventory. Smoother care.')).toBeVisible()
    expect(
      within(clinicTeam).getByText(
        "Keep essential clinic supplies organized, visible, and ready when they're needed."
      )
    ).toBeVisible()
    expect(within(clinicTeam).queryByText('ANY TIME DENTAL')).not.toBeInTheDocument()
    expect(
      within(clinicTeam).queryByText('Inventory made simpler for your clinic.')
    ).not.toBeInTheDocument()

    expect(screen.queryByText('LOCAL · SECURE · OFFLINE-READY')).not.toBeInTheDocument()
    expect(
      screen.queryByText('A focused inventory workspace for dental supplies.')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        'Inventory information remains on this Windows computer. Hardware activation is safely disabled during Phase 2.'
      )
    ).not.toBeInTheDocument()
  })

  it('shows Access Denied after invalid credentials', async () => {
    const user = userEvent.setup()
    render(<App />)

    const username = await screen.findByLabelText('Username')
    const password = screen.getByLabelText('Password')
    const signIn = screen.getByRole('button', { name: 'Sign In' })

    expect(username).toBeVisible()
    expect(password).toBeVisible()
    expect(signIn).toBeVisible()

    expect(username).toHaveFocus()
    await user.tab()
    expect(password).toHaveFocus()
    await user.tab()
    expect(signIn).toHaveFocus()

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
    const api = createDesktopApi({ authenticated: false })
    api.auth.login = login
    api.auth.logout = logout
    installDesktopApi(api)

    render(<App />)
    await user.type(await screen.findByLabelText('Username'), 'admin')
    await user.type(screen.getByLabelText('Password'), 'valid-password')
    await user.click(screen.getByRole('button', { name: 'Sign In' }))

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
    expect(
      await screen.findByRole('heading', { name: 'Dental Inventory Management System' })
    ).toBeVisible()
    expect(screen.getByLabelText('Username')).toBeVisible()
    expect(screen.getByLabelText('Password')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeVisible()
    expect(logout).toHaveBeenCalledOnce()
  })

  it('shows connected ESP32, mode, RTC, and MicroSD status in the shell', async () => {
    installDesktopApi(
      createDesktopApi({
        hardware: {
          getStatus: vi.fn().mockResolvedValue({
            connection: 'CONNECTED',
            device: 'dental-inventory-esp32',
            mode: 'restock',
            rtc: true,
            sd: true
          })
        }
      })
    )

    render(<App />)
    const status = await screen.findByRole('status', { name: 'ESP32 hardware status' })

    expect(await within(status).findByText('Connected')).toBeVisible()
    expect(within(status).getByText('Restock')).toBeVisible()
    expect(within(status).getAllByText('Available')).toHaveLength(2)
  })

  it('shows a clean offline state when hardware polling fails', async () => {
    installDesktopApi(
      createDesktopApi({
        hardware: {
          getStatus: vi.fn().mockRejectedValue(new Error('network unavailable'))
        }
      })
    )

    render(<App />)
    const status = await screen.findByRole('status', { name: 'ESP32 hardware status' })

    expect(await within(status).findByText('Offline')).toBeVisible()
    expect(within(status).getAllByText('Unavailable')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'Item Inventory' })).toBeVisible()
  })

  it('polls every four seconds without continuing after the shell unmounts', async () => {
    vi.useFakeTimers()
    const getStatus = vi.fn().mockResolvedValue({
      connection: 'CONNECTED',
      device: 'dental-inventory-esp32',
      mode: 'idle',
      rtc: true,
      sd: true
    })
    installDesktopApi(createDesktopApi({ hardware: { getStatus } }))

    try {
      const view = render(<App />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(getStatus).toHaveBeenCalledOnce()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000)
      })
      expect(getStatus).toHaveBeenCalledTimes(2)

      view.unmount()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000)
      })
      expect(getStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never overlaps polling when a hardware request remains pending', async () => {
    vi.useFakeTimers()
    const connectedStatus: HardwareStatusDto = {
      connection: 'CONNECTED',
      device: 'dental-inventory-esp32',
      mode: 'idle',
      rtc: true,
      sd: true
    }
    let resolveFirstRequest!: (value: HardwareStatusDto) => void
    const firstRequest = new Promise<HardwareStatusDto>((resolve) => {
      resolveFirstRequest = resolve
    })
    const getStatus = vi
      .fn()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValue(connectedStatus)
    installDesktopApi(createDesktopApi({ hardware: { getStatus } }))

    try {
      const view = render(<App />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(getStatus).toHaveBeenCalledOnce()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_000)
      })
      expect(getStatus).toHaveBeenCalledOnce()

      await act(async () => {
        resolveFirstRequest(connectedStatus)
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(getStatus).toHaveBeenCalledTimes(2)
      view.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses Any Time Dental shell branding and clinic-facing inactive sync guidance', async () => {
    const user = userEvent.setup()
    installDesktopApi(createDesktopApi())

    render(<App />)

    const clinicBrandLabels = await screen.findAllByText('Any Time Dental')
    expect(clinicBrandLabels).toHaveLength(2)
    clinicBrandLabels.forEach((label) => expect(label).toBeVisible())
    expect(screen.getByText('DENTAL INVENTORY MANAGEMENT SYSTEM')).toBeVisible()
    const emptyStateLogo = await screen.findByRole('img', { name: 'Any Time Dental' })
    expect(emptyStateLogo).toBeVisible()
    expect(emptyStateLogo.getAttribute('src')).toContain('any-time-dental-logo.png')
    expect(screen.queryByText('DI')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'SYNC OFFLINE' }))
    expect(
      screen.getByRole('heading', { name: 'Offline synchronization is waiting for the kiosk' })
    ).toBeVisible()
    expect(
      screen.getByText(
        'Offline synchronization will become available when the inventory kiosk is connected.'
      )
    ).toBeVisible()

    expect(screen.queryByText(/Phase 2/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Hardware disabled/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Not implemented in this phase/i)).not.toBeInTheDocument()
  })

  it('renders database products, image fallbacks, and all stock statuses', async () => {
    const products = [
      product(),
      product({
        id: 2,
        barcode: '000200',
        itemName: 'Endodontic File',
        category: 'Endodontics',
        imageUrl: 'dental-image://products/endodontic-file.jpg',
        currentStock: 3,
        status: 'LOW'
      }),
      product({
        id: 3,
        barcode: '000300',
        itemName: 'Surgical Suture',
        category: 'Surgery',
        currentStock: 0,
        status: 'EMPTY'
      })
    ]
    installDesktopApi(
      createDesktopApi({ inventory: { listProducts: filteredProductList(() => products) } })
    )

    render(<App />)
    const table = await screen.findByRole('table', { name: 'Item inventory' })

    expect(within(table).getByText('Composite Resin')).toBeVisible()
    expect(within(table).getByText('HIGH')).toBeVisible()
    expect(within(table).getByText('LOW')).toBeVisible()
    expect(within(table).getByText('EMPTY')).toBeVisible()
    expect(screen.getByRole('img', { name: 'No image for Composite Resin' })).toBeVisible()

    const loadedImage = screen.getByAltText('Endodontic File reference')
    expect(loadedImage).toHaveAttribute('src', 'dental-image://products/endodontic-file.jpg')
    fireEvent.error(loadedImage)
    expect(screen.getByRole('img', { name: 'No image for Endodontic File' })).toBeVisible()
  })

  it('searches by item name and leading-zero barcode and filters fixed categories', async () => {
    const user = userEvent.setup()
    const products = [
      product(),
      product({
        id: 2,
        barcode: '000200',
        itemName: 'Endodontic File',
        category: 'Endodontics'
      }),
      product({ id: 3, barcode: '98765', itemName: 'Arch Wire', category: 'Orthodontics' })
    ]
    installDesktopApi(
      createDesktopApi({ inventory: { listProducts: filteredProductList(() => products) } })
    )

    render(<App />)
    await screen.findByText('Composite Resin')

    const search = screen.getByLabelText('Search inventory')
    await user.type(search, 'endodontic')
    await waitFor(() => expect(screen.queryByText('Composite Resin')).not.toBeInTheDocument())
    expect(screen.getByText('Endodontic File')).toBeVisible()

    await user.clear(search)
    await user.type(search, '00012345')
    expect(await screen.findByText('Composite Resin')).toBeVisible()
    expect(screen.queryByText('Endodontic File')).not.toBeInTheDocument()

    await user.clear(search)
    const category = screen.getByLabelText('Filter by category')
    expect(within(category).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All categories',
      'General',
      'Restorative & Esthetic',
      'Endodontics',
      'Prosthodontics',
      'Surgery',
      'Orthodontics'
    ])
    await user.selectOptions(category, 'Orthodontics')
    expect(await screen.findByText('Arch Wire')).toBeVisible()
    expect(screen.queryByText('Composite Resin')).not.toBeInTheDocument()
  })

  it('validates required fields and rejects negative or fractional stock values in the form', async () => {
    const user = userEvent.setup()
    const createProduct = vi.fn()
    installDesktopApi(createDesktopApi({ inventory: { createProduct } }))

    render(<App />)
    await openAddItem(user)
    expect(screen.getByText('Manual barcode entry')).toBeVisible()
    expect(screen.queryByText('Development entry only')).not.toBeInTheDocument()
    expect(screen.queryByText(/Hardware scanner integration/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(screen.getByText('Barcode / SKU is required.')).toBeVisible()
    expect(screen.getByText('Item name is required.')).toBeVisible()
    expect(screen.getByText('Select one of the approved categories.')).toBeVisible()
    expect(createProduct).not.toHaveBeenCalled()

    await completeRequiredAddFields(user, { stock: '-1', threshold: '1.5' })
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(screen.getByText(/Stock must be a whole number/)).toBeVisible()
    expect(screen.getByText(/Low-stock threshold must be a whole number/)).toBeVisible()
    expect(createProduct).not.toHaveBeenCalled()
  })

  it('selects an image, preserves leading zeroes, creates an item, and refreshes inventory', async () => {
    const user = userEvent.setup()
    let products: ProductDto[] = []
    const createdProduct = product()
    const createProduct = vi.fn(async () => {
      products = [createdProduct]
      return { ok: true as const, value: createdProduct }
    })
    const selectImage = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        selectionToken: 'opaque-selection-token',
        previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
        originalName: 'composite.png'
      }
    })
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listProducts: filteredProductList(() => products),
          createProduct,
          selectImage
        }
      })
    )

    render(<App />)
    await openAddItem(user)
    await user.click(screen.getByRole('button', { name: 'Browse for a reference image' }))
    expect(await screen.findByAltText('Reference image preview')).toHaveAttribute(
      'src',
      'data:image/png;base64,cHJldmlldw=='
    )
    await completeRequiredAddFields(user)
    await user.click(screen.getByRole('button', { name: 'Add item' }))

    expect(await screen.findByText('Composite Resin was added successfully.')).toBeVisible()
    expect(await screen.findByText('Composite Resin')).toBeVisible()
    expect(createProduct).toHaveBeenCalledWith({
      barcode: '00012345',
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      initialStock: 12,
      lowStockThreshold: 5,
      imageSelectionToken: 'opaque-selection-token'
    })
  })

  it('accepts a supported dropped image, shows drag feedback, and can remove it before saving', async () => {
    const user = userEvent.setup()
    const droppedImage = new File(['valid-image'], 'clinic-item.png', { type: 'image/png' })
    const selectedImage = {
      selectionToken: 'dropped-selection-token',
      previewDataUrl: 'data:image/png;base64,ZHJvcHBlZA==',
      originalName: 'clinic-item.png'
    }
    const selectDroppedImage = vi.fn().mockResolvedValue({ ok: true, value: selectedImage })
    const createProduct = vi.fn().mockResolvedValue({ ok: true, value: product() })
    installDesktopApi(
      createDesktopApi({ inventory: { selectDroppedImage, createProduct } })
    )

    render(<App />)
    await openAddItem(user)
    const dropZone = screen.getByRole('button', { name: 'Browse for a reference image' })
    const dataTransfer = {
      files: [droppedImage],
      types: ['Files'],
      items: [{ kind: 'file', type: 'image/png' }],
      dropEffect: 'none'
    }

    fireEvent.dragEnter(dropZone, { dataTransfer })
    expect(screen.getByText('Release to add image')).toBeVisible()
    fireEvent.dragLeave(dropZone, { dataTransfer })
    expect(screen.getByText('Drop an image here')).toBeVisible()
    fireEvent.dragEnter(dropZone, { dataTransfer })
    fireEvent.drop(dropZone, { dataTransfer })

    expect(await screen.findByAltText('Reference image preview')).toHaveAttribute(
      'src',
      selectedImage.previewDataUrl
    )
    expect(selectDroppedImage).toHaveBeenCalledWith(droppedImage)

    await user.click(screen.getByRole('button', { name: 'Remove image' }))
    expect(screen.queryByAltText('Reference image preview')).not.toBeInTheDocument()
    expect(screen.getByText('Drop an image here')).toBeVisible()

    await completeRequiredAddFields(user)
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(createProduct).toHaveBeenCalledWith(
      expect.objectContaining({ imageSelectionToken: null })
    )
  })

  it('reports an unsupported dropped file and globally prevents file-drop navigation', async () => {
    const user = userEvent.setup()
    const unsupportedFile = new File(['plain text'], 'notes.txt', { type: 'text/plain' })
    const selectDroppedImage = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'IMAGE_INVALID_TYPE', message: 'Select a PNG, JPG, JPEG, or WEBP image.' }
    })
    installDesktopApi(createDesktopApi({ inventory: { selectDroppedImage } }))

    render(<App />)
    await openAddItem(user)
    const dropZone = screen.getByRole('button', { name: 'Browse for a reference image' })
    const dataTransfer = {
      files: [unsupportedFile],
      types: ['Files'],
      items: [{ kind: 'file', type: 'text/plain' }],
      dropEffect: 'none'
    }

    fireEvent.dragEnter(dropZone, { dataTransfer })
    expect(screen.getByText('Unsupported image format')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Select a PNG, JPG, JPEG, or WEBP image.'
    )
    fireEvent.drop(dropZone, { dataTransfer })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Select a PNG, JPG, JPEG, or WEBP image.'
    )

    const windowDrop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(windowDrop, 'dataTransfer', {
      value: { types: ['Files'] }
    })
    window.dispatchEvent(windowDrop)
    expect(windowDrop.defaultPrevented).toBe(true)
  })

  it('shows the backend duplicate-barcode rejection without overwriting inventory', async () => {
    const user = userEvent.setup()
    const createProduct = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'DUPLICATE_BARCODE',
        message: 'A product with this barcode already exists.'
      }
    })
    installDesktopApi(createDesktopApi({ inventory: { createProduct } }))

    render(<App />)
    await openAddItem(user)
    await completeRequiredAddFields(user)
    await user.click(screen.getByRole('button', { name: 'Add item' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A product with this barcode already exists.'
    )
    expect(screen.getByLabelText('Barcode / SKU')).toHaveValue('00012345')
    expect(createProduct).toHaveBeenCalledOnce()
  })

  it('edits product details and records an administrative stock correction in history', async () => {
    const user = userEvent.setup()
    let products = [product()]
    const correction: MovementHistoryDto = {
      transactionId: 'correction-001',
      occurredAt: '2026-08-31T02:30:00.000Z',
      itemName: 'Composite Resin Plus',
      category: 'General',
      action: 'STOCK_CORRECTION',
      quantity: -4,
      newTotal: 8
    }
    const updateProduct = vi.fn(async (input) => {
      const updated = product({
        itemName: input.itemName,
        category: input.category,
        currentStock: input.currentStock,
        lowStockThreshold: input.lowStockThreshold,
        status: 'HIGH'
      })
      products = [updated]
      return { ok: true as const, value: updated }
    })
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listProducts: filteredProductList(() => products),
          updateProduct,
          listMovementHistory: vi.fn().mockResolvedValue({ ok: true, value: [correction] })
        }
      })
    )

    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Edit Composite Resin' }))
    expect(screen.getByRole('dialog', { name: 'Edit Composite Resin' })).toBeVisible()
    expect(screen.getByText('00012345')).toBeVisible()

    const name = screen.getByLabelText('Item Name')
    await user.clear(name)
    await user.type(name, 'Composite Resin Plus')
    await user.selectOptions(screen.getByLabelText('Category'), 'General')
    const stock = screen.getByLabelText('Current Stock — administrative correction')
    await user.clear(stock)
    await user.type(stock, '8')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Composite Resin Plus')).toBeVisible()
    expect(updateProduct).toHaveBeenCalledWith({
      id: 1,
      itemName: 'Composite Resin Plus',
      category: 'General',
      currentStock: 8,
      lowStockThreshold: 5
    })
    await user.click(screen.getByRole('tab', { name: 'MOVEMENT HISTORY' }))
    const history = await screen.findByRole('table', { name: 'Movement history' })
    expect(within(history).getByText('STOCK CORRECTION')).toBeVisible()
    expect(within(history).getByText('-4')).toBeVisible()
    expect(within(history).getByText('8')).toBeVisible()
  })

  it('removes an existing product image without changing item fields or stock', async () => {
    const user = userEvent.setup()
    const picturedProduct = product({
      imageUrl: 'dental-image://product/00000000-0000-4000-8000-000000000001.jpg'
    })
    const updateProduct = vi.fn().mockResolvedValue({
      ok: true,
      value: { ...picturedProduct, imageUrl: null }
    })
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listProducts: filteredProductList(() => [picturedProduct]),
          updateProduct
        }
      })
    )

    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Edit Composite Resin' }))
    const editDialog = screen.getByRole('dialog', { name: 'Edit Composite Resin' })
    expect(within(editDialog).getByAltText('Composite Resin reference')).toBeVisible()

    await user.click(within(editDialog).getByRole('button', { name: 'Remove image' }))
    expect(within(editDialog).queryByAltText('Composite Resin reference')).not.toBeInTheDocument()
    expect(within(editDialog).getByText('Drop an image here')).toBeVisible()
    expect(within(editDialog).getByLabelText('Item Name')).toHaveValue('Composite Resin')
    expect(within(editDialog).getByLabelText('Category')).toHaveValue('Restorative & Esthetic')
    expect(within(editDialog).getByLabelText('Current Stock — administrative correction')).toHaveValue(
      '12'
    )

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(updateProduct).toHaveBeenCalledWith({
      id: 1,
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      currentStock: 12,
      lowStockThreshold: 5,
      removeImage: true
    })
  })

  it('replaces an existing product image without emitting the removal flag', async () => {
    const user = userEvent.setup()
    const picturedProduct = product({
      imageUrl: 'dental-image://product/00000000-0000-4000-8000-000000000001.jpg'
    })
    const selectImage = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        selectionToken: 'replacement-token',
        previewDataUrl: 'data:image/webp;base64,cmVwbGFjZW1lbnQ=',
        originalName: 'replacement.webp'
      }
    })
    const updateProduct = vi.fn().mockResolvedValue({ ok: true, value: picturedProduct })
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listProducts: filteredProductList(() => [picturedProduct]),
          selectImage,
          updateProduct
        }
      })
    )

    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Edit Composite Resin' }))
    await user.click(screen.getByRole('button', { name: 'Replace image' }))
    expect(await screen.findByAltText('Reference image preview')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(updateProduct).toHaveBeenCalledWith({
      id: 1,
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      currentStock: 12,
      lowStockThreshold: 5,
      replacementImageSelectionToken: 'replacement-token'
    })
  })

  it('requires named delete confirmation, removes the product, and preserves history', async () => {
    const user = userEvent.setup()
    let products = [product()]
    const deleteProduct = vi.fn(async ({ id }: { id: number }) => {
      products = products.filter((item) => item.id !== id)
      return { ok: true as const, value: { deletedProductId: id } }
    })
    const historyRecord: MovementHistoryDto = {
      transactionId: 'correction-before-delete',
      occurredAt: '2026-08-31T02:30:00.000Z',
      itemName: 'Composite Resin',
      category: 'Restorative & Esthetic',
      action: 'STOCK_CORRECTION',
      quantity: 2,
      newTotal: 12
    }
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listProducts: filteredProductList(() => products),
          deleteProduct,
          listMovementHistory: vi.fn().mockResolvedValue({ ok: true, value: [historyRecord] })
        }
      })
    )

    render(<App />)
    await user.click(await screen.findByRole('button', { name: 'Edit Composite Resin' }))
    await user.click(screen.getByRole('button', { name: 'Delete item' }))
    expect(screen.getByRole('dialog', { name: 'Delete Composite Resin?' })).toBeVisible()
    expect(deleteProduct).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Keep item' }))
    expect(screen.getByRole('dialog', { name: 'Edit Composite Resin' })).toBeVisible()
    expect(deleteProduct).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete item' }))
    await user.click(screen.getByRole('button', { name: 'Delete Composite Resin' }))
    expect(await screen.findByRole('heading', { name: 'No products in inventory' })).toBeVisible()
    expect(screen.queryByText('Composite Resin')).not.toBeInTheDocument()
    expect(deleteProduct).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('tab', { name: 'MOVEMENT HISTORY' }))
    const history = await screen.findByRole('table', { name: 'Movement history' })
    expect(within(history).getByText('Composite Resin')).toBeVisible()
  })

  it('shows persistent movement records in the supplied newest-first order', async () => {
    const user = userEvent.setup()
    const records: MovementHistoryDto[] = [
      {
        transactionId: 'newest',
        occurredAt: '2026-08-31T04:00:00.000Z',
        itemName: 'Newest Item',
        category: 'Surgery',
        action: 'STOCK_CORRECTION',
        quantity: 3,
        newTotal: 9
      },
      {
        transactionId: 'older',
        occurredAt: '2026-08-30T04:00:00.000Z',
        itemName: 'Older Item',
        category: 'General',
        action: 'STOCK_CORRECTION',
        quantity: -1,
        newTotal: 2
      }
    ]
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listMovementHistory: vi.fn().mockResolvedValue({ ok: true, value: records })
        }
      })
    )

    render(<App />)
    await user.click(await screen.findByRole('tab', { name: 'MOVEMENT HISTORY' }))
    const table = await screen.findByRole('table', { name: 'Movement history' })
    const rows = within(table).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent('Newest Item')
    expect(rows[2]).toHaveTextContent('Older Item')
  })

  it('presents restock and checkout quantities with their actual inventory direction', async () => {
    const user = userEvent.setup()
    const records: MovementHistoryDto[] = [
      {
        transactionId: 'restock-001',
        occurredAt: '2026-08-31T05:00:00.000Z',
        itemName: 'Restocked Item',
        category: 'General',
        action: 'RESTOCK',
        quantity: 2,
        newTotal: 7
      },
      {
        transactionId: 'checkout-001',
        occurredAt: '2026-08-31T04:30:00.000Z',
        itemName: 'Checked Out Item',
        category: 'Surgery',
        action: 'CHECKOUT',
        quantity: 1,
        newTotal: 4
      }
    ]
    installDesktopApi(
      createDesktopApi({
        inventory: {
          listMovementHistory: vi.fn().mockResolvedValue({ ok: true, value: records })
        }
      })
    )

    render(<App />)
    await user.click(await screen.findByRole('tab', { name: 'MOVEMENT HISTORY' }))
    const rows = within(await screen.findByRole('table', { name: 'Movement history' })).getAllByRole(
      'row'
    )

    expect(rows[1]).toHaveTextContent('+2')
    expect(rows[2]).toHaveTextContent('-1')
  })
})
