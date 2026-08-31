import { describe, expect, it } from "vitest";
import {
  CONNECTION_STATUSES,
  PROTOCOL_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  STOCK_STATUSES,
  TRANSACTION_MODES,
  TRANSACTION_STATUSES,
  assertProtocolMessage,
  getProtocolValidationErrors,
  validateProtocolMessage,
  type ProtocolMessage,
} from "../src/index";

const baseEnvelope = {
  protocol_version: PROTOCOL_VERSION,
  message_id: "message-001",
  correlation_id: null,
  device_id: "ESP32-KIOSK-01",
  sent_at: "2026-08-30T16:45:12+08:00",
} as const;

const validMessages: ProtocolMessage[] = [
  {
    ...baseEnvelope,
    type: "device.status",
    payload: {
      connection_status: "CONNECTED",
      firmware_version: "0.1.0",
      hardware_activation_enabled: false,
      uptime_ms: 100,
    },
  },
  {
    ...baseEnvelope,
    type: "heartbeat",
    payload: { sequence: 1, uptime_ms: 100 },
  },
  {
    ...baseEnvelope,
    type: "mode.changed",
    payload: { mode: "RESTOCK" },
  },
  {
    ...baseEnvelope,
    type: "barcode.scanned",
    payload: {
      barcode: "4801234567890",
      scanned_at: "2026-08-30 16:45:12",
    },
  },
  {
    ...baseEnvelope,
    type: "transaction.request",
    payload: {
      transaction_id: "transaction-001",
      mode: "CHECKOUT",
      barcode: "4801234567890",
      occurred_at: "2026-08-30 16:45:12",
      rtc_valid: true,
    },
  },
  {
    ...baseEnvelope,
    type: "transaction.confirmed",
    payload: {
      transaction_id: "transaction-001",
      mode: "CHECKOUT",
      quantity: 2,
      previous_stock: 5,
      new_total: 3,
      stock_status: "LOW",
      transaction_status: "SUCCESS",
    },
  },
  {
    ...baseEnvelope,
    type: "transaction.rejected",
    payload: {
      transaction_id: "transaction-002",
      code: "INSUFFICIENT_STOCK",
      message: "Checkout quantity exceeds current stock.",
      retryable: false,
      transaction_status: "ERROR",
    },
  },
  {
    ...baseEnvelope,
    type: "error.response",
    payload: {
      code: "MALFORMED_MESSAGE",
      message: "Message could not be parsed.",
      retryable: false,
    },
  },
];

describe("protocol constants", () => {
  it("defines only the approved Phase 1 messages and enum values", () => {
    expect(PROTOCOL_MESSAGE_TYPES).toEqual([
      "device.status",
      "heartbeat",
      "mode.changed",
      "barcode.scanned",
      "transaction.request",
      "transaction.confirmed",
      "transaction.rejected",
      "error.response",
    ]);
    expect(TRANSACTION_MODES).toEqual(["RESTOCK", "CHECKOUT"]);
    expect(STOCK_STATUSES).toEqual(["HIGH", "LOW", "EMPTY"]);
    expect(TRANSACTION_STATUSES).toEqual(["SUCCESS", "ERROR", "IDLE"]);
    expect(CONNECTION_STATUSES).toEqual(["CONNECTED", "DISCONNECTED"]);
  });
});

describe("protocol JSON Schema validation", () => {
  it.each(validMessages)("accepts $type", (message) => {
    expect(validateProtocolMessage(message)).toBe(true);
  });

  it("rejects an unsupported protocol version", () => {
    const candidate = { ...validMessages[1], protocol_version: 2 };

    expect(validateProtocolMessage(candidate)).toBe(false);
    expect(getProtocolValidationErrors().length).toBeGreaterThan(0);
  });

  it("rejects an invalid transaction mode", () => {
    const candidate = {
      ...validMessages[2],
      payload: { mode: "RETURN" },
    };

    expect(validateProtocolMessage(candidate)).toBe(false);
  });

  it("rejects unknown properties", () => {
    const candidate = { ...validMessages[1], unapproved_field: true };

    expect(validateProtocolMessage(candidate)).toBe(false);
  });

  it("provides an assertion helper", () => {
    expect(() => assertProtocolMessage(validMessages[0])).not.toThrow();
    expect(() => assertProtocolMessage({})).toThrow(/Invalid protocol message/i);
  });
});

