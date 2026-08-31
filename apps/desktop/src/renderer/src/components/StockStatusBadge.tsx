import type { StockStatus } from '../../../shared/ipc-contract'

export function StockStatusBadge({ status }: { status: StockStatus }) {
  return <span className={`stock-badge stock-badge--${status.toLowerCase()}`}>{status}</span>
}
