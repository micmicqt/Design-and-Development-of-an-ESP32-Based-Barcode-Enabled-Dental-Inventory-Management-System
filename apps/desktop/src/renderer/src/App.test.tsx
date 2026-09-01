import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopApi,
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
  inventory = {}
}: {
  authenticated?: boolean
  inventory?: Partial<DesktopApi['inventory']>
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
    }
  }
}

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

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Composite Resin was added successfully.'
    )
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
