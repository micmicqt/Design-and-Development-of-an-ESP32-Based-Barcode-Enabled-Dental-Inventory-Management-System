import { useEffect, useState } from 'react'
import {
  INVENTORY_CATEGORIES,
  type InventoryCategory,
  type ProductDto
} from '../../../shared/ipc-contract'
import { EditProductDialog } from '../components/EditProductDialog'
import { ProductImage } from '../components/ProductImage'
import { StockStatusBadge } from '../components/StockStatusBadge'
import clinicLogo from '../assets/branding/any-time-dental-logo.png'

export function InventoryPage({
  refreshVersion,
  notice,
  onHistoryChanged
}: {
  refreshVersion: number
  notice: string | null
  onHistoryChanged: () => void
}) {
  const [products, setProducts] = useState<ProductDto[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<InventoryCategory | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadVersion, setReloadVersion] = useState(0)
  const [editingProduct, setEditingProduct] = useState<ProductDto | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)

    window.desktopApi.inventory
      .listProducts({ search: search.trim(), category })
      .then((result) => {
        if (!active) return
        if (result.ok) {
          setProducts(result.value)
        } else {
          setProducts([])
          setLoadError(result.error.message)
        }
      })
      .catch(() => {
        if (!active) return
        setProducts([])
        setLoadError('Inventory could not be loaded. Please try again.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [category, refreshVersion, reloadVersion, search])

  function refreshInventory(): void {
    setReloadVersion((current) => current + 1)
  }

  return (
    <div className="inventory-page">
      {notice !== null && (
        <div className="form-alert form-alert--success inventory-notice" role="status">
          {notice}
        </div>
      )}

      <div className="inventory-toolbar">
        <div className="search-field">
          <label htmlFor="inventory-search">Search inventory</label>
          <input
            id="inventory-search"
            type="search"
            placeholder="Item name or barcode"
            maxLength={256}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="filter-field">
          <label htmlFor="category-filter">Filter by category</label>
          <select
            id="category-filter"
            value={category ?? ''}
            onChange={(event) =>
              setCategory(event.target.value === '' ? null : (event.target.value as InventoryCategory))
            }
          >
            <option value="">All categories</option>
            {INVENTORY_CATEGORIES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="inventory-count" aria-live="polite">
          <strong>{products.length}</strong>
          <span>{products.length === 1 ? 'item shown' : 'items shown'}</span>
        </div>
      </div>

      {loadError !== null && (
        <div className="form-alert form-alert--error page-alert" role="alert">
          {loadError}
        </div>
      )}

      {loading && products.length === 0 && loadError === null ? (
        <div className="page-loading" role="status">
          Loading inventory…
        </div>
      ) : null}

      {!loading && loadError === null && products.length === 0 ? (
        <div className="table-empty-state">
          <span className="empty-state-logo">
            <img src={clinicLogo} alt="Any Time Dental" />
          </span>
          <h3>{search.trim() || category ? 'No matching products' : 'No products in inventory'}</h3>
          <p>
            {search.trim() || category
              ? 'Try a different item name, barcode, or category.'
              : 'Use Add New Item to register the first dental supply.'}
          </p>
        </div>
      ) : null}

      {products.length > 0 ? (
        <div className="table-scroll" aria-busy={loading}>
          <table className="data-table" aria-label="Item inventory">
            <thead>
              <tr>
                <th scope="col">Image</th>
                <th scope="col">Item Name</th>
                <th scope="col">Category</th>
                <th scope="col">Unit Type</th>
                <th scope="col">Stock</th>
                <th scope="col">Status</th>
                <th scope="col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td className="data-table__image-cell">
                    <ProductImage imageUrl={product.imageUrl} itemName={product.itemName} />
                  </td>
                  <td>
                    <strong className="item-name">{product.itemName}</strong>
                    <small className="item-barcode">SKU {product.barcode}</small>
                  </td>
                  <td>{product.category}</td>
                  <td><span className="unit-type-value">{product.unitType}</span></td>
                  <td>
                    <strong className="stock-value">{product.currentStock}</strong>
                  </td>
                  <td>
                    <StockStatusBadge status={product.status} />
                  </td>
                  <td>
                    <button
                      className="table-action"
                      type="button"
                      aria-label={`Edit ${product.itemName}`}
                      onClick={() => setEditingProduct(product)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editingProduct !== null && (
        <EditProductDialog
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onSaved={(stockChanged) => {
            setEditingProduct(null)
            refreshInventory()
            if (stockChanged) onHistoryChanged()
          }}
          onDeleted={() => {
            setEditingProduct(null)
            refreshInventory()
          }}
        />
      )}
    </div>
  )
}
