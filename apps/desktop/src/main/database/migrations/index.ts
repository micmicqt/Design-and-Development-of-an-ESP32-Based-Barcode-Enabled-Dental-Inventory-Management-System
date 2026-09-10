import { initialSchemaMigration } from "./001-initial-schema";
import { phase2InventoryMigration } from "./002-phase-2-inventory";
import { phase5Step2HardwareTransactionsMigration } from "./003-phase-5-step-2-hardware-transactions";
import { phase5Step3ResultDeliveryMigration } from './004-phase-5-step-3-result-delivery'
import { phase7Step2OfflineReconciliationMigration } from './005-phase-7-step-2-offline-reconciliation'
import type { DatabaseMigration } from "./types";

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  initialSchemaMigration,
  phase2InventoryMigration,
  phase5Step2HardwareTransactionsMigration,
  phase5Step3ResultDeliveryMigration,
  phase7Step2OfflineReconciliationMigration
];

export type { DatabaseMigration } from "./types";
