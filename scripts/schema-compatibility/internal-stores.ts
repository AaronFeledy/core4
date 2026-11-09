import { GLOBAL_POLICY_VERSION, GlobalPolicy } from "@lando/engine/global-app/enablement";
import { INCLUDE_LOCKFILE_VERSION, LockEntriesSchema } from "@lando/landofile/include-lockfile";
import { Schema } from "effect";
import {
  RUNTIME_SHUTDOWN_VERSION,
  RuntimeShutdownReceipt,
} from "../../container-runtime/src/podman/runtime-shutdown.ts";
import {
  RESOURCE_OWNERSHIP_VERSION,
  ResourceOwnershipInventory,
} from "../../container-runtime/src/resource-ownership.ts";
import {
  GLOBAL_RECONCILIATION_VERSION,
  GlobalReconciliationState,
  pendingOperations,
} from "../../engine/src/global-app/reconciliation.ts";
import {
  PENDING_START_VERSION,
  PendingStart,
  pendingStartTransitions,
} from "../../engine/src/operations/accelerated-start-record.ts";
import { AppDataIdentityRecord, appDataIdentityTransitions } from "../../engine/src/planner/data-identity.ts";
import {
  SCRATCH_REGISTRY_VERSION,
  ScratchRegistryEntriesSchema,
  scratchRegistryTransitions,
} from "../../engine/src/scratch-app/registry.ts";
import { TUNNEL_REGISTRY_VERSION, TunnelRegistryEntries } from "../../engine/src/tunnel/registry-migrate.ts";
import {
  UPDATE_HANDOFF_RECEIPT_VERSION,
  UpdateHandoffReceiptSchema,
  receiptTransitions as updateHandoffTransitions,
} from "../../engine/src/update/handoff.ts";
import {
  UPDATE_MANIFEST_STATE_VERSION,
  UpdateManifestStateSchema,
} from "../../engine/src/update/manifest.ts";
import { LEDGER_VERSION, LedgerStateSchema, ledgerTransitions } from "../../managed-file/src/ledger.ts";
import { JOURNAL_VERSION, Journal, journalTransitions } from "../../managed-file/src/transaction-journal.ts";
import {
  SESSION_LEDGER_VERSION,
  SessionLedger,
  drainTransitions,
  receiptTransitions as sessionReceiptTransitions,
} from "../../plugins/file-sync-mutagen/src/session-ledger.ts";
import { shutdownTransitions } from "../../plugins/provider-lando/src/runtime-shutdown.ts";
import {
  PUBLISHED_CONTAINER_RECEIPT_VERSION,
  PublishedContainerReceiptSchema,
} from "../../plugins/provider-lando/src/windows-nft-receipt.ts";
import {
  WINDOWS_SYNC_HELPER_RECEIPT_VERSION,
  WindowsSyncHelperReceipt,
  transitions as windowsSyncHelperTransitions,
} from "../../plugins/provider-lando/src/windows-sync-helper-receipt.ts";
import { SqliteSnapshotInfo } from "../../plugins/sql/src/sqlite-snapshot.ts";
import { SNAPSHOT_INFO_VERSION, SnapshotInfo } from "../../sdk/src/schema/data-transfer.ts";
import { VolumeInitializationRecord } from "../../sdk/src/schema/volume-initialization.ts";
import {
  VOLUME_INITIALIZATION_VERSION,
  transitions as volumeInitializationTransitions,
} from "../../state-store/src/volume-initialization.ts";

/** A `defineTransitions` table: every state an edge leaves, enters, or settles in. */
interface TransitionTable {
  readonly edges: Readonly<
    Record<
      string,
      {
        readonly from: ReadonlyArray<string>;
        readonly to?: string;
        readonly settledIn?: ReadonlyArray<string>;
      }
    >
  >;
}

/** An operation table over independent obligations: the kinds each operation may add or clear. */
interface ObligationTable {
  readonly obligations: Readonly<
    Record<string, { readonly adds: ReadonlyArray<string>; readonly clears: ReadonlyArray<string> }>
  >;
}

/**
 * How a stored enum that names a lifecycle (`status`, `phase`, `state`) changes:
 * through a declared table, by re-deriving it from host observation each run
 * (`observed`), or not at all because it is plain data (`none`).
 */
export type LifecycleDeclaration = TransitionTable | ObligationTable | "observed" | "none";

/**
 * One declaration for the whole store, or one per enum field path (`.` between
 * properties, `[]` for array items and record values). A field map may also name
 * a lifecycle field that is not called `status`, `phase`, or `state`.
 */
export type StoreLifecycle =
  | LifecycleDeclaration
  | { readonly presence: TransitionTable }
  | { readonly fields: Readonly<Record<string, LifecycleDeclaration>> };

/** Where the bucket spec is written: repo-relative file and the `schema:` expression text. */
export interface BucketSite {
  readonly file: string;
  readonly schema: string;
}

interface InternalPersistedStore {
  readonly id: string;
  readonly schema: Schema.Top;
  readonly version: number;
  readonly source: BucketSite;
  readonly lifecycle: StoreLifecycle;
}

// Register the decode schema exactly as StateStore.open receives it, including wrappers.
// Traefik acquisition state is a plain file that re-derives on decode failure,
// not a versioned StateStore bucket, so it does not belong in this registry.
export const INTERNAL_PERSISTED_STORES = [
  {
    id: "runtime-shutdown",
    schema: RuntimeShutdownReceipt,
    version: RUNTIME_SHUTDOWN_VERSION,
    source: { file: "plugins/provider-lando/src/runtime-shutdown.ts", schema: "RuntimeShutdownReceipt" },
    lifecycle: shutdownTransitions,
  },
  {
    id: "sqlite-snapshot-sidecar",
    schema: SqliteSnapshotInfo,
    version: SNAPSHOT_INFO_VERSION,
    source: { file: "plugins/sql/src/sqlite-snapshot.ts", schema: "SqliteSnapshotInfo" },
    lifecycle: "none",
  },
  {
    id: "app-data-identity",
    schema: AppDataIdentityRecord,
    version: 1,
    source: { file: "engine/src/planner/data-identity.ts", schema: "AppDataIdentityRecord" },
    lifecycle: { presence: appDataIdentityTransitions },
  },
  {
    id: "managed-file-journal",
    schema: Journal,
    version: JOURNAL_VERSION,
    source: { file: "managed-file/src/transaction-journal.ts", schema: "Journal" },
    lifecycle: journalTransitions,
  },
  {
    id: "managed-file-ledger",
    schema: LedgerStateSchema,
    version: LEDGER_VERSION,
    source: { file: "managed-file/src/service.ts", schema: "LedgerStateSchema" },
    lifecycle: ledgerTransitions,
  },
  {
    id: "update-manifest-state",
    schema: UpdateManifestStateSchema,
    version: UPDATE_MANIFEST_STATE_VERSION,
    source: { file: "engine/src/update/manifest.ts", schema: "UpdateManifestStateSchema" },
    lifecycle: "none",
  },
  {
    id: "scratch-registry",
    schema: ScratchRegistryEntriesSchema,
    version: SCRATCH_REGISTRY_VERSION,
    source: { file: "engine/src/scratch-app/registry.ts", schema: "ScratchRegistryEntriesSchema" },
    lifecycle: scratchRegistryTransitions,
  },
  {
    id: "tunnel-registry",
    schema: TunnelRegistryEntries,
    version: TUNNEL_REGISTRY_VERSION,
    source: { file: "engine/src/tunnel/registry.ts", schema: "TunnelRegistryEntries" },
    lifecycle: "none",
  },
  {
    id: "update-handoff-receipt",
    schema: Schema.NullOr(UpdateHandoffReceiptSchema),
    version: UPDATE_HANDOFF_RECEIPT_VERSION,
    source: { file: "engine/src/update/handoff.ts", schema: "Schema.NullOr(UpdateHandoffReceiptSchema)" },
    lifecycle: {
      fields: {
        deferred: updateHandoffTransitions,
        // Per-plugin update outcomes recorded for the re-executed binary to report.
        "completedRows[].status": "none",
        "result.pluginResults[].status": "none",
      },
    },
  },
  {
    id: "accelerated-start",
    schema: PendingStart,
    version: PENDING_START_VERSION,
    source: { file: "engine/src/operations/accelerated-start-record.ts", schema: "PendingStart" },
    lifecycle: { fields: { phase: pendingStartTransitions } },
  },
  {
    id: "global-reconciliation",
    schema: GlobalReconciliationState,
    version: GLOBAL_RECONCILIATION_VERSION,
    source: { file: "engine/src/global-app/reconciliation.ts", schema: "GlobalReconciliationState" },
    lifecycle: { obligations: pendingOperations },
  },
  {
    id: "mutagen-session-ledger",
    schema: SessionLedger,
    version: SESSION_LEDGER_VERSION,
    source: { file: "plugins/file-sync-mutagen/src/session-ledger.ts", schema: "SessionLedger" },
    lifecycle: {
      fields: { "sessions[].phase": sessionReceiptTransitions, "appDrains[].phase": drainTransitions },
    },
  },
  {
    id: "volume-initialization",
    schema: Schema.NullOr(VolumeInitializationRecord),
    version: VOLUME_INITIALIZATION_VERSION,
    source: {
      file: "state-store/src/volume-initialization.ts",
      schema: "Schema.NullOr(VolumeInitializationRecord)",
    },
    lifecycle: volumeInitializationTransitions,
  },
  {
    id: "windows-sync-helper-receipt",
    schema: WindowsSyncHelperReceipt,
    version: WINDOWS_SYNC_HELPER_RECEIPT_VERSION,
    source: {
      file: "plugins/provider-lando/src/windows-sync-helper-receipt.ts",
      schema: "WindowsSyncHelperReceipt",
    },
    lifecycle: windowsSyncHelperTransitions,
  },
  {
    id: "resource-ownership",
    schema: ResourceOwnershipInventory,
    version: RESOURCE_OWNERSHIP_VERSION,
    source: { file: "container-runtime/src/resource-ownership.ts", schema: "Inventory" },
    lifecycle: "none",
  },
  {
    id: "snapshot-sidecar",
    schema: SnapshotInfo,
    version: SNAPSHOT_INFO_VERSION,
    source: { file: "data-mover/src/snapshot-catalog.ts", schema: "SnapshotInfo" },
    lifecycle: "none",
  },
  {
    id: "global-policy",
    schema: GlobalPolicy,
    version: GLOBAL_POLICY_VERSION,
    source: { file: "engine/src/global-app/enablement.ts", schema: "GlobalPolicy" },
    lifecycle: "none",
  },
  {
    id: "include-lockfile",
    schema: LockEntriesSchema,
    version: INCLUDE_LOCKFILE_VERSION,
    source: { file: "landofile/src/include-lockfile.ts", schema: "LockEntriesSchema" },
    lifecycle: "none",
  },
  {
    id: "windows-published-container-receipt",
    schema: PublishedContainerReceiptSchema,
    version: PUBLISHED_CONTAINER_RECEIPT_VERSION,
    source: {
      file: "plugins/provider-lando/src/windows-nft-receipt.ts",
      schema: "PublishedContainerReceiptSchema",
    },
    lifecycle: "none",
  },
] as const satisfies ReadonlyArray<InternalPersistedStore>;

export type InternalPersistedStoreId = (typeof INTERNAL_PERSISTED_STORES)[number]["id"];

/**
 * Durable bucket specs that deliberately stay out of the registry. Each reason
 * says why a narrowed schema cannot strand state a later run depends on, or
 * which other surface already guards it.
 */
export const UNREGISTERED_DURABLE_BUCKETS: ReadonlyArray<BucketSite & { readonly reason: string }> = [
  {
    file: "container-runtime/src/applied-state.ts",
    schema: "AppPlan",
    reason: "Guarded as the published applied-state store through the AppPlan schema surface.",
  },
  {
    file: "container-runtime/src/applied-state.ts",
    schema: "AppliedPlans",
    reason: "Record of AppPlan values; guarded as the published applied-state store.",
  },
  {
    file: "core/src/cli/commands/list-prune-state.ts",
    schema: "AppliedPlans",
    reason: "Prune-only reader of the applied-state store; discards what it cannot decode.",
  },
  {
    file: "core/src/cli/commands/list-prune-state.ts",
    schema: "AppliedPlanIdentity",
    reason: "Prune-only identity read of per-app applied-state records owned by container-runtime.",
  },
  {
    file: "core/src/cli/commands/list-prune-state.ts",
    schema: "LegacyAppliedPlan",
    reason: "Frozen legacy inventory format that is only read so it can be deleted.",
  },
  {
    file: "engine/src/scratch-app/plan.ts",
    schema: "AppPlan",
    reason: "Plan cache: quarantined on corruption, discarded on version mismatch, re-planned.",
  },
  {
    file: "engine/src/services/host-shell-history.ts",
    schema: "HistorySchema",
    reason: "Free-form shell history lines through a text codec; no structured shape to narrow.",
  },
  {
    file: "plugins/provider-lando/src/plugin-runtime.ts",
    schema: "Schema.String",
    reason: "Opaque runtime generation token; any string decodes.",
  },
  {
    file: "plugins/proxy-traefik/src/route-reload-state.ts",
    schema: "AckSchema",
    reason: "Reload acknowledgement digest; discarding it only forces one extra Traefik reload.",
  },
];
