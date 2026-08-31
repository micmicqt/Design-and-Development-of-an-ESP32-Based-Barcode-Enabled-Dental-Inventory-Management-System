import { useEffect, useState } from 'react'
import type { MovementHistoryDto } from '../../../shared/ipc-contract'

function formatDateTime(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

export function MovementHistoryPage({ refreshVersion }: { refreshVersion: number }) {
  const [records, setRecords] = useState<MovementHistoryDto[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)

    window.desktopApi.inventory
      .listMovementHistory()
      .then((result) => {
        if (!active) return
        if (result.ok) {
          setRecords(result.value)
        } else {
          setRecords([])
          setLoadError(result.error.message)
        }
      })
      .catch(() => {
        if (!active) return
        setRecords([])
        setLoadError('Movement history could not be loaded. Please try again.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [refreshVersion])

  if (loading && records.length === 0) {
    return (
      <div className="page-loading" role="status">
        Loading movement history…
      </div>
    )
  }

  if (loadError !== null) {
    return (
      <div className="form-alert form-alert--error page-alert" role="alert">
        {loadError}
      </div>
    )
  }

  if (records.length === 0) {
    return (
      <div className="table-empty-state">
        <span aria-hidden="true">DI</span>
        <h3>No movement history yet</h3>
        <p>Administrative stock corrections will appear here after they are saved.</p>
      </div>
    )
  }

  return (
    <div className="history-page">
      <div className="history-summary">
        <strong>{records.length}</strong>
        <span>{records.length === 1 ? 'permanent record' : 'permanent records'}</span>
      </div>
      <div className="table-scroll">
        <table className="data-table data-table--history" aria-label="Movement history">
          <thead>
            <tr>
              <th scope="col">Date &amp; Time</th>
              <th scope="col">Item Name</th>
              <th scope="col">Category</th>
              <th scope="col">Action</th>
              <th scope="col">QTY</th>
              <th scope="col">New Total</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr key={record.transactionId}>
                <td>
                  <time dateTime={record.occurredAt}>{formatDateTime(record.occurredAt)}</time>
                </td>
                <td>
                  <strong className="item-name">{record.itemName}</strong>
                </td>
                <td>{record.category}</td>
                <td>
                  <span className="movement-badge">{record.action.replaceAll('_', ' ')}</span>
                </td>
                <td>{record.quantity}</td>
                <td>
                  <strong className="stock-value">{record.newTotal}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
