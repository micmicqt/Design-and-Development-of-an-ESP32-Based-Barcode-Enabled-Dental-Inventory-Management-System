// @vitest-environment node

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initializeDatabase, type SqliteDatabase } from '../../src/main/database'
import type { HardwareTransactionEventGateway } from '../../src/main/hardware/hardware-gateway'
import { createHardwareTransactionCoordinator } from '../../src/main/hardware/hardware-transaction-coordinator'
import { createInventoryService } from '../../src/main/inventory'
import type { HardwareTransactionEvent } from '../../src/shared/ipc-contract'

const event: HardwareTransactionEvent = {
  eventId: 'evt-restart-result-1',
  mode: 'checkout',
  barcode: '0000123456',
  timestamp: '2026-09-05 14:00:00'
}

function createGateway(): HardwareTransactionEventGateway {
  return {
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    getNextTransactionEvent: vi.fn().mockResolvedValue(event),
    deliverTransactionResult: vi.fn().mockResolvedValue(undefined),
    acknowledgeTransactionEvent: vi.fn().mockResolvedValue(undefined)
  }
}

describe('hardware transaction recovery across application restart', () => {
  const directories: string[] = []
  let database: SqliteDatabase | null = null

  afterEach(() => {
    database?.close()
    database = null
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reopens a result-delivered receipt and retries ACK without mutation or result resend', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dental-result-recovery-'))
    directories.push(directory)
    const databasePath = join(directory, 'inventory.db')

    database = initializeDatabase({ databasePath })
    const initialInventory = createInventoryService(database, {
      createTransactionId: () => 'movement-restart-1'
    })
    initialInventory.createProduct({
      barcode: event.barcode,
      itemName: 'Restart Test Product',
      category: 'General',
      initialStock: 5,
      lowStockThreshold: 2
    })
    const firstGateway = createGateway()
    vi.mocked(firstGateway.acknowledgeTransactionEvent).mockRejectedValue(
      new Error('simulated lost ACK response')
    )
    const firstCoordinator = createHardwareTransactionCoordinator({
      inventoryService: initialInventory,
      gateway: firstGateway
    })

    await expect(
      firstCoordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toMatchObject({
      acknowledged: false,
      receipt: { newTotal: 3, resultDeliveredToHardware: true }
    })
    expect(firstGateway.deliverTransactionResult).toHaveBeenCalledTimes(1)
    database.close()
    database = null

    database = initializeDatabase({ databasePath })
    const reopenedInventory = createInventoryService(database, {
      createTransactionId: () => {
        throw new Error('Recovery must not allocate another movement ID.')
      }
    })
    const recoveryGateway = createGateway()
    const recoveryCoordinator = createHardwareTransactionCoordinator({
      inventoryService: reopenedInventory,
      gateway: recoveryGateway
    })

    await expect(
      recoveryCoordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toMatchObject({
      acknowledged: true,
      receipt: { newTotal: 3, resultDeliveredToHardware: true }
    })
    expect(recoveryGateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(recoveryGateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      event.eventId
    )
    expect(reopenedInventory.findProductByBarcode(event.barcode)?.currentStock).toBe(3)
    expect(reopenedInventory.listMovementHistory()).toHaveLength(1)
  })

  it('reopens an undelivered receipt and retries result then ACK without another mutation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dental-result-recovery-'))
    directories.push(directory)
    const databasePath = join(directory, 'inventory.db')

    database = initializeDatabase({ databasePath })
    const initialInventory = createInventoryService(database, {
      createTransactionId: () => 'movement-restart-2'
    })
    initialInventory.createProduct({
      barcode: event.barcode,
      itemName: 'Restart Test Product',
      category: 'General',
      initialStock: 5,
      lowStockThreshold: 2
    })
    const firstGateway = createGateway()
    vi.mocked(firstGateway.deliverTransactionResult).mockRejectedValue(
      new Error('simulated lost result response')
    )
    const firstCoordinator = createHardwareTransactionCoordinator({
      inventoryService: initialInventory,
      gateway: firstGateway
    })

    await expect(
      firstCoordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toMatchObject({
      acknowledged: false,
      receipt: { newTotal: 3, resultDeliveredToHardware: false }
    })
    expect(firstGateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
    database.close()
    database = null

    database = initializeDatabase({ databasePath })
    const reopenedInventory = createInventoryService(database, {
      createTransactionId: () => {
        throw new Error('Recovery must not allocate another movement ID.')
      }
    })
    const recoveryGateway = createGateway()
    const recoveryCoordinator = createHardwareTransactionCoordinator({
      inventoryService: reopenedInventory,
      gateway: recoveryGateway
    })

    await expect(
      recoveryCoordinator.retryTransactionResultDelivery(event.eventId)
    ).resolves.toMatchObject({
      acknowledged: true,
      receipt: { newTotal: 3, resultDeliveredToHardware: true }
    })
    expect(recoveryGateway.deliverTransactionResult).toHaveBeenCalledExactlyOnceWith({
      eventId: event.eventId,
      result: 'success',
      mode: event.mode,
      quantity: 2,
      resultingStock: 3,
      stockStatus: 'HIGH'
    })
    expect(recoveryGateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      event.eventId
    )
    expect(reopenedInventory.findProductByBarcode(event.barcode)?.currentStock).toBe(3)
    expect(reopenedInventory.listMovementHistory()).toHaveLength(1)
  })
})
