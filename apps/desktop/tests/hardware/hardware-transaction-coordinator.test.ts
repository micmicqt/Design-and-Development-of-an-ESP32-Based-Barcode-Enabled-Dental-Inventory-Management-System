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
  HardwareTransactionReceipt,
  HardwareTransactionResult
} from '../../src/shared/ipc-contract'

const event: HardwareTransactionEvent = {
  eventId: 'evt-session-1',
  mode: 'restock',
  barcode: '0004806016001569',
  timestamp: '2026-09-05 09:00:00'
}

const pendingReceipt: HardwareTransactionReceipt = {
  ...event,
  transactionId: 'movement-1',
  productId: 7,
  itemName: 'Cleanser',
  category: 'General',
  quantity: 2,
  previousStock: 20,
  newTotal: 22,
  status: 'HIGH',
  resultDeliveredToHardware: false
}

const deliveredReceipt: HardwareTransactionReceipt = {
  ...pendingReceipt,
  resultDeliveredToHardware: true
}

const expectedResult: HardwareTransactionResult = {
  eventId: event.eventId,
  result: 'success',
  mode: 'restock',
  quantity: 2,
  resultingStock: 22,
  stockStatus: 'HIGH'
}

function createGateway(): HardwareTransactionEventGateway {
  return {
    healthCheck: vi.fn(),
    getStatus: vi.fn(),
    sendDesktopHeartbeat: vi.fn().mockResolvedValue(undefined),
    getNextTransactionEvent: vi.fn().mockResolvedValue(event),
    deliverTransactionResult: vi.fn().mockResolvedValue(undefined),
    acknowledgeTransactionEvent: vi.fn().mockResolvedValue(undefined)
  }
}

function createInventory(
  existingReceipt: HardwareTransactionReceipt | null = null
): HardwareTransactionInventoryService {
  return {
    findHardwareTransactionReceipt: vi.fn().mockReturnValue(existingReceipt),
    processHardwareTransaction: vi.fn().mockReturnValue(pendingReceipt),
    markHardwareTransactionResultDelivered: vi.fn().mockReturnValue(deliveredReceipt)
  }
}

describe('hardware transaction coordinator', () => {
  it('orders FIFO validation, SQLite commit, result delivery, durable marker, then ACK', async () => {
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
      return pendingReceipt
    })
    vi.mocked(gateway.deliverTransactionResult).mockImplementation(async (result) => {
      calls.push('result')
      expect(result).toEqual(expectedResult)
    })
    vi.mocked(inventory.markHardwareTransactionResultDelivered).mockImplementation(() => {
      calls.push('mark-result')
      return deliveredReceipt
    })
    vi.mocked(gateway.acknowledgeTransactionEvent).mockImplementation(async () => {
      calls.push('ack')
    })

    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })
    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })

    expect(calls).toEqual(['head', 'commit', 'head', 'result', 'mark-result', 'ack'])
  })

  it('sends neither result nor ACK when the SQLite transaction fails', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    vi.mocked(inventory.processHardwareTransaction).mockImplementation(() => {
      throw new Error('simulated SQLite failure')
    })
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).rejects.toThrow('simulated SQLite failure')
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('keeps a committed receipt pending when result delivery fails and retries without mutation', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    vi.mocked(gateway.deliverTransactionResult)
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(undefined)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toEqual({ receipt: pendingReceipt, acknowledged: false })
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()

    vi.mocked(inventory.findHardwareTransactionReceipt).mockReturnValue(pendingReceipt)
    await expect(
      coordinator.retryTransactionResultDelivery(event.eventId)
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })
    expect(gateway.deliverTransactionResult).toHaveBeenCalledTimes(2)
    expect(gateway.deliverTransactionResult).toHaveBeenNthCalledWith(1, expectedResult)
    expect(gateway.deliverTransactionResult).toHaveBeenNthCalledWith(2, expectedResult)
    expect(inventory.processHardwareTransaction).toHaveBeenCalledTimes(1)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledTimes(1)
  })

  it('persists the result boundary before an ACK failure and retries ACK only', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    vi.mocked(gateway.acknowledgeTransactionEvent)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(undefined)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 2 })
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: false })

    vi.mocked(inventory.findHardwareTransactionReceipt).mockReturnValue(deliveredReceipt)
    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })
    expect(inventory.processHardwareTransaction).toHaveBeenCalledTimes(1)
    expect(gateway.deliverTransactionResult).toHaveBeenCalledTimes(1)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledTimes(2)
  })

  it('recovers an undelivered durable receipt after coordinator recreation', async () => {
    const gateway = createGateway()
    const inventory = createInventory(pendingReceipt)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: event.eventId, quantity: 999 })
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })
    expect(inventory.processHardwareTransaction).not.toHaveBeenCalled()
    expect(gateway.deliverTransactionResult).toHaveBeenCalledExactlyOnceWith(expectedResult)
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
  })

  it('recovers a delivered receipt after coordinator recreation with ACK only', async () => {
    const gateway = createGateway()
    const inventory = createInventory(deliveredReceipt)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(event.eventId)
  })

  it('treats an empty queue as a lost ACK response only after result delivery', async () => {
    const gateway = createGateway()
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValue(null)

    const deliveredCoordinator = createHardwareTransactionCoordinator({
      inventoryService: createInventory(deliveredReceipt),
      gateway
    })
    await expect(
      deliveredCoordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })

    const pendingCoordinator = createHardwareTransactionCoordinator({
      inventoryService: createInventory(pendingReceipt),
      gateway
    })
    await expect(
      pendingCoordinator.retryTransactionResultDelivery(event.eventId)
    ).resolves.toEqual({ receipt: pendingReceipt, acknowledged: false })
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('uses the recent-ACK receipt when a lost response exposes the next FIFO head', async () => {
    const gateway = createGateway()
    const nextEvent: HardwareTransactionEvent = {
      eventId: 'evt-device-session-2',
      mode: 'checkout',
      barcode: '0099999999999',
      timestamp: '2026-09-05 09:01:00'
    }
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValue(nextEvent)
    const coordinator = createHardwareTransactionCoordinator({
      inventoryService: createInventory(deliveredReceipt),
      gateway
    })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).resolves.toEqual({ receipt: deliveredReceipt, acknowledged: true })
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).toHaveBeenCalledExactlyOnceWith(
      event.eventId
    )
  })

  it('returns committed-but-incomplete when hardware is unavailable', async () => {
    const inventory = createInventory(pendingReceipt)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway: null })

    await expect(
      coordinator.retryTransactionResultDelivery(event.eventId)
    ).resolves.toEqual({ receipt: pendingReceipt, acknowledged: false })
    expect(inventory.processHardwareTransaction).not.toHaveBeenCalled()
  })

  it('rejects a new request whose ID does not match the current FIFO head', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.processTransaction({ eventId: 'evt-other', quantity: 2 })
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({ code: 'EVENT_MISMATCH' })
    expect(inventory.processHardwareTransaction).not.toHaveBeenCalled()
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('rejects a reused event ID whose authoritative event differs from its receipt', async () => {
    const gateway = createGateway()
    const inventory = createInventory(pendingReceipt)
    vi.mocked(gateway.getNextTransactionEvent).mockResolvedValue({ ...event, barcode: 'different' })
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.retryTransactionResultDelivery(event.eventId)
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({ code: 'EVENT_MISMATCH' })
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('requires a durable receipt for either recovery route', async () => {
    const gateway = createGateway()
    const inventory = createInventory()
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    await expect(
      coordinator.retryTransactionResultDelivery(event.eventId)
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({ code: 'RECEIPT_NOT_FOUND' })
    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({ code: 'RECEIPT_NOT_FOUND' })
    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
  })

  it('forbids ACK-only recovery before result delivery', async () => {
    const gateway = createGateway()
    const coordinator = createHardwareTransactionCoordinator({
      inventoryService: createInventory(pendingReceipt),
      gateway
    })

    await expect(
      coordinator.retryTransactionAcknowledgement(event.eventId)
    ).rejects.toMatchObject<Partial<HardwareTransactionCoordinatorError>>({
      code: 'RESULT_NOT_DELIVERED'
    })
    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })

  it('reads a durable receipt without contacting hardware', () => {
    const gateway = createGateway()
    const inventory = createInventory(deliveredReceipt)
    const coordinator = createHardwareTransactionCoordinator({ inventoryService: inventory, gateway })

    expect(coordinator.getTransactionReceipt(event.eventId)).toEqual(deliveredReceipt)
    expect(gateway.getNextTransactionEvent).not.toHaveBeenCalled()
    expect(gateway.deliverTransactionResult).not.toHaveBeenCalled()
    expect(gateway.acknowledgeTransactionEvent).not.toHaveBeenCalled()
  })
})
