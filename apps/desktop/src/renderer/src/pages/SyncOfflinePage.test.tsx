import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncOfflinePage } from './SyncOfflinePage'

afterEach(cleanup)

describe('authoritative offline journal reporting', () => {
  it('keeps two last-known records after sync and status failures and ignores a stale preview', async () => {
    let resolvePreview!: (value: unknown) => void
    const getNextOfflineEvent = vi.fn(() => new Promise((resolve) => { resolvePreview = resolve }))
    Object.defineProperty(window, 'desktopApi', { configurable: true, value: { hardware: {
      getNextOfflineEvent, getStatus: vi.fn().mockResolvedValue({}),
      synchronizeOfflineInventory: vi.fn().mockResolvedValue({ ok: false,
        error: { message: 'Pending transaction retrieval timed out.' } })
    } } })
    const view = render(<SyncOfflinePage pendingCount={2} offlineReady offlineJournalState="ready" />)
    fireEvent.click(screen.getByRole('button', { name: 'Synchronize offline transactions' }))
    await screen.findByText('Pending transaction retrieval timed out.')
    resolvePreview({ ok: false, error: { message: 'OLD PREVIEW FAILURE' } })
    view.rerender(<SyncOfflinePage pendingCount={undefined} offlineReady={undefined} />)
    const summary = screen.getByLabelText('Offline journal status')
    expect(within(summary).getByText('2')).toBeVisible()
    expect(within(summary).getByText('Ready')).toBeVisible()
    expect(screen.getByText(/Last known journal status/)).toBeVisible()
    expect(screen.queryByText('OLD PREVIEW FAILURE')).not.toBeInTheDocument()
  })
  it('shows healthy zero as 0 / Ready / empty preview', async () => {
    const getNextOfflineEvent = vi.fn().mockResolvedValue({ ok: true, value: null })
    Object.defineProperty(window, 'desktopApi', { configurable: true,
      value: { hardware: { getNextOfflineEvent } } })
    render(<SyncOfflinePage pendingCount={0} offlineReady={false} offlineJournalState="empty" />)
    expect(screen.getByText('0')).toBeVisible()
    expect(screen.getByText('Ready')).toBeVisible()
    expect(await screen.findByText('No pending kiosk transaction is visible.')).toBeVisible()
    expect(screen.queryByText('Not reported')).not.toBeInTheDocument()
  })

  it('does not invent zero during transport failure and reloads after recovery', async () => {
    const getNextOfflineEvent = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { message: 'transport unavailable' } })
      .mockResolvedValueOnce({ ok: true, value: null })
    Object.defineProperty(window, 'desktopApi', { configurable: true,
      value: { hardware: { getNextOfflineEvent } } })
    const view = render(<SyncOfflinePage pendingCount={undefined} offlineReady={undefined}
      offlineJournalState="temporarily_unavailable" />)
    expect(screen.getByText('Not reported')).toBeVisible()
    expect(screen.getByText('Temporarily unavailable')).toBeVisible()
    await screen.findByText('Pending transaction preview is unavailable.')
    view.rerender(<SyncOfflinePage pendingCount={0} offlineReady={true} offlineJournalState="empty" />)
    await waitFor(() => expect(getNextOfflineEvent).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No pending kiosk transaction is visible.')).toBeVisible()
    expect(screen.getByText('Ready')).toBeVisible()
  })

  it.each([
    ['recovering', 'Recovering'], ['corrupt', 'Integrity check failed'],
    ['full', 'Full — synchronize pending records'],
    ['generation_mismatch', 'Inventory snapshot mismatch']
  ] as const)('shows %s explicitly', async (offlineJournalState, label) => {
    Object.defineProperty(window, 'desktopApi', { configurable: true,
      value: { hardware: { getNextOfflineEvent: vi.fn().mockResolvedValue({ ok: true, value: null }) } } })
    render(<SyncOfflinePage pendingCount={undefined} offlineReady={undefined}
      offlineJournalState={offlineJournalState} />)
    expect(screen.getByText(label)).toBeVisible()
    await screen.findByText('No pending kiosk transaction is visible.')
  })

  it('does not let a completed sync override later authoritative health or counts', async () => {
    const synchronizeOfflineInventory = vi.fn().mockResolvedValue({ ok: true, value: {
      status: 'COMPLETE', counts: { appliedEvents: 0, alreadyAppliedEvents: 0, acknowledgedEvents: 0 },
      pendingSyncItems: 0, cache: { generation: `v1-${'a'.repeat(64)}`, itemCount: 2, alreadyCurrent: true }
    } })
    Object.defineProperty(window, 'desktopApi', { configurable: true, value: { hardware: {
      getNextOfflineEvent: vi.fn().mockResolvedValue({ ok: true, value: null }),
      getStatus: vi.fn().mockResolvedValue({}), synchronizeOfflineInventory
    } } })
    const view = render(<SyncOfflinePage pendingCount={0} offlineReady={true} offlineJournalState="empty" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Verify and refresh cache' }))
    await waitFor(() => expect(synchronizeOfflineInventory).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verify and refresh cache' })).toBeEnabled())
    view.rerender(<SyncOfflinePage pendingCount={undefined} offlineReady={undefined}
      offlineJournalState="temporarily_unavailable" />)
    const summary = screen.getByLabelText('Offline journal status')
    expect(within(summary).getByText('Not reported')).toBeVisible()
    expect(within(summary).queryByText('0')).not.toBeInTheDocument()
    view.rerender(<SyncOfflinePage pendingCount={2} offlineReady={true} offlineJournalState="ready" />)
    expect(within(summary).getByText('2')).toBeVisible()
    expect(within(summary).getByText('Ready')).toBeVisible()
  })
})
