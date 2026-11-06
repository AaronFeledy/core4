import { Schema } from "effect";
import {
  GLOBAL_RECONCILIATION_VERSION,
  GlobalReconciliationState,
} from "../../engine/src/global-app/reconciliation.ts";
import { PENDING_START_VERSION, PendingStart } from "../../engine/src/operations/accelerated-start-record.ts";
import {
  SCRATCH_REGISTRY_VERSION,
  ScratchRegistryEntriesSchema,
} from "../../engine/src/scratch-app/registry.ts";
import {
  UPDATE_HANDOFF_RECEIPT_VERSION,
  UpdateHandoffReceiptSchema,
} from "../../engine/src/update/handoff.ts";
import { SESSION_LEDGER_VERSION, SessionLedger } from "../../plugins/file-sync-mutagen/src/session-ledger.ts";

// Register the decode schema exactly as StateStore.open receives it, including wrappers.
// Traefik acquisition state is a plain file that re-derives on decode failure,
// not a versioned StateStore bucket, so it does not belong in this registry.
export const INTERNAL_PERSISTED_STORES = [
  { id: "scratch-registry", schema: ScratchRegistryEntriesSchema, version: SCRATCH_REGISTRY_VERSION },
  {
    id: "update-handoff-receipt",
    schema: Schema.NullOr(UpdateHandoffReceiptSchema),
    version: UPDATE_HANDOFF_RECEIPT_VERSION,
  },
  { id: "accelerated-start", schema: PendingStart, version: PENDING_START_VERSION },
  { id: "global-reconciliation", schema: GlobalReconciliationState, version: GLOBAL_RECONCILIATION_VERSION },
  { id: "mutagen-session-ledger", schema: SessionLedger, version: SESSION_LEDGER_VERSION },
] as const;

export type InternalPersistedStoreId = (typeof INTERNAL_PERSISTED_STORES)[number]["id"];
