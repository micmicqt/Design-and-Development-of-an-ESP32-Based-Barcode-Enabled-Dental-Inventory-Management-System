export const PROTOCOL_VERSION = 1 as const;

export const TRANSACTION_MODES = ["RESTOCK", "CHECKOUT"] as const;
export type TransactionMode = (typeof TRANSACTION_MODES)[number];

export const STOCK_STATUSES = ["HIGH", "LOW", "EMPTY"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const TRANSACTION_STATUSES = ["SUCCESS", "ERROR", "IDLE"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const CONNECTION_STATUSES = ["CONNECTED", "DISCONNECTED"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const PROTOCOL_MESSAGE_TYPES = [
  "device.status",
  "heartbeat",
  "mode.changed",
  "barcode.scanned",
  "transaction.request",
  "transaction.confirmed",
  "transaction.rejected",
  "error.response",
] as const;

export type ProtocolMessageType = (typeof PROTOCOL_MESSAGE_TYPES)[number];

export interface ProtocolEnvelope<
  TType extends ProtocolMessageType,
  TPayload,
> {
  protocol_version: typeof PROTOCOL_VERSION;
  type: TType;
  message_id: string;
  correlation_id: string | null;
  device_id: string;
  sent_at: string;
  payload: TPayload;
}

export interface DeviceStatusPayload {
  connection_status: ConnectionStatus;
  firmware_version: string;
  hardware_activation_enabled: boolean;
  uptime_ms: number;
}

export type DeviceStatusMessage = ProtocolEnvelope<
  "device.status",
  DeviceStatusPayload
>;

export interface HeartbeatPayload {
  sequence: number;
  uptime_ms: number;
}

export type HeartbeatMessage = ProtocolEnvelope<"heartbeat", HeartbeatPayload>;

export interface ModeChangedPayload {
  mode: TransactionMode;
}

export type ModeChangedMessage = ProtocolEnvelope<
  "mode.changed",
  ModeChangedPayload
>;

export interface BarcodeScannedPayload {
  barcode: string;
  scanned_at: string;
}

export type BarcodeScannedMessage = ProtocolEnvelope<
  "barcode.scanned",
  BarcodeScannedPayload
>;

export interface TransactionRequestPayload {
  transaction_id: string;
  mode: TransactionMode;
  barcode: string;
  occurred_at: string;
  rtc_valid: boolean;
}

export type TransactionRequestMessage = ProtocolEnvelope<
  "transaction.request",
  TransactionRequestPayload
>;

export interface TransactionConfirmedPayload {
  transaction_id: string;
  mode: TransactionMode;
  quantity: number;
  previous_stock: number;
  new_total: number;
  stock_status: StockStatus;
  transaction_status: "SUCCESS";
}

export type TransactionConfirmedMessage = ProtocolEnvelope<
  "transaction.confirmed",
  TransactionConfirmedPayload
>;

export interface TransactionRejectedPayload {
  transaction_id: string;
  code: string;
  message: string;
  retryable: boolean;
  transaction_status: "ERROR";
}

export type TransactionRejectedMessage = ProtocolEnvelope<
  "transaction.rejected",
  TransactionRejectedPayload
>;

export interface ErrorResponsePayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type ErrorResponseMessage = ProtocolEnvelope<
  "error.response",
  ErrorResponsePayload
>;

export type ProtocolMessage =
  | DeviceStatusMessage
  | HeartbeatMessage
  | ModeChangedMessage
  | BarcodeScannedMessage
  | TransactionRequestMessage
  | TransactionConfirmedMessage
  | TransactionRejectedMessage
  | ErrorResponseMessage;

