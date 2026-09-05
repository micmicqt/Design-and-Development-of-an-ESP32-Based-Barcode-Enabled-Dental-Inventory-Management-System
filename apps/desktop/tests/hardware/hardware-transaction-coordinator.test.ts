// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import {
  createHardwareTransactionCoordinator,
  type HardwareTransactionCoordinatorError,
  type HardwareTransactionInventoryService
} from '../../src/main/hardware/hardware-transaction-coordinator'
import type { HardwareTransactionEventGateway } from '../../src/main/hardware/hardware-gateway'
import type {
  HardwareTransactionEvent,
  HardwareTransactionReceipt
} from '../../src/shared/ipc-contract'

const event: HardwareTransactionEvent = {
  eventId: 'evt-session-1',
  mode: 'restock',
  barcode: '0004806016001569',
  timestamp: '2026-09-05 09:00:00'
}

const receipt: HardwareTransactionReceipt = {
  ...event,
  transactionId: 'movement-1',
  productId: 7,
  itemName: 'Cleanser',
  category: 'General',
  quantity: 2,
  previousStock: 20,
  newTotal: 22,
  status: 'HIGH'
}

function createGateway(): HardwareTransactionEventGateway {
  return {
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    getNextTransactionEvent: vi.fn().mockResolvedValue(event),
    acknowledgeTransactionEvent: vi.fn().mockResolvedValue(undefined)
  }
}

function createInventory(
  existingReceipt: HardwareTransactionReceipt | null = null
): HardwareTransactionInventoryService {
  return {
    findHardwareTransactionReceipt: vi.fn().mockReturnValue(existingReceipt),
    processHardwareTransaction: vi.fn().mockReturnValue(receipt)
  }
}

describe('hardware transaction coordinator', () => {
  it('uses the authoritative FIFO head and commits before acknowledging it', async () => {
    const calls: string[] = []
    const gateway = createGateway()
    const inventory = createInventory()
    vi.mocked(gateway.getNextTransactionEvent).mockImplementation(async () => {
      calls.push('head')
      return event
    })
    vi.mocked(inventory.processHardwareTransaction).mockImplementation((input) => {
      calls.push('commit')
      expect(input).toEqual({ event, quantity: 2 })
      return receipt
    })
    vi.mocked(gateway.acknowledgeTransactionEvent).mockImplementation(async () => {
      calls.push('ack')
    })

    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })
    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toEqual({ receipt, acknowledged: true })

    expect(calls).toEqual(['head', 'commit', 'head', 'ack'])
  })

  it('does not acknowledge when the database transaction fails', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    vi.mocked(inventory.processHardwareTransaction).mockImplementation(() => {
      throw new Error('simulated SQLite failure')
    })
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).rejects.toThrow('simulated SQLite failure')
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('returns a committed outcome when ACK fails and retries without another mutation', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    vi.mocked(gateway.acknowledgeTransactionEvent)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(undefined)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toEqual({ receipt, acknowledged: false })

    vi.mocked(inventory.findHardwareTransactionReceipt).mockReturnValue(receipt)
    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt, acknowledged: true })
    expect(inventory.processHardwareTransaction).toHaveBeenCalledTimes(1)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledTimes(2)
  })

  it('recognizes a durable receipt after coordinator recreation and performs ACK only', async () => {
    const gateway = createGateway()
    const inventory = createInventory(receipt)
    const recreatedCoordinator = createHardwareTransactionCoordinator({
      inventoryService: inventory,
      gateway
    })

    await expect(
      recreatedCoordinator.processTransaction({ eventId: event.eventId, quantity: 999 })
    ).resolves.toEqual({ receipt, acknowledged: true })
    expect(inventory.processHardwareTransaction).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
  })

  it('treats an empty queue as an ACK that already succeeded after commit', async () => {
    const gateway = createGateway()
    const inventory = createInventory(receipt)
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValue(null)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt, acknowledged: true })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('returns committed-but-unacknowledged when hardware is unavailable after commit', async () => {
    const inventory = createInventory(receipt)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway: null })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt, acknowledged: false })
    expect(inventory.processHardwareTransaction).not.toHaveBeenCalled()
  })

  it('rejects a new request whose ID does not match the current FIFO head', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: 'evt-other', quantity: 2 })
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({
      code: 'EVENT_MISMATCH'
    })
    expect(inventory.processHardwareTransaction).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('rejects a reused event ID whose authoritative event differs from its receipt', async () => {
    const gateway = createGateway()
    const inventory = createInventory(receipt)
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValue({ ...event, barcode: 'different' })
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({
      code: 'EVENT_MISMATCH'
    })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('requires a durable receipt before entering ACK-only retry', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({
      code: 'RECEIPT_NOT_FOUND'
    })
    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('reads a durable receipt without contacting hardware', () => {
    const gateway = createGateway()
    const inventory = createInventory(receipt)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    expect(coordinator.getTransactionReceipt(event.eventId)).toEqual(receipt)
    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })
})
