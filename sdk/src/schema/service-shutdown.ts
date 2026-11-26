import { Schema } from "effect";

import { TaggedErrorJson } from "./machine-output.ts";
import { AppId, ProviderId, ServiceName } from "./primitives.ts";
import { OwnedResourcesCleanupResult } from "./resource-ownership.ts";
import { VolumeRemovalCounts } from "./volume-removal.ts";

// ==== Shutdown observations
// Daemon-reported facts, never a graceful or forced shutdown verdict.

const identityFields = {
  appId: AppId.annotate({ description: "Identity of the app owning the observed service." }),
  providerId: ProviderId.annotate({ description: "Provider holding the observed container." }),
  service: ServiceName.annotate({ description: "Service name within the owning app." }),
  containerId: Schema.optionalKey(Schema.String).annotate({
    description: "Exact container identity inspected, when known; never a replacement found by name.",
  }),
  oomKilled: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Explicit daemon-reported OOM bit; omission means unknown, not false.",
  }),
};

const unknownFields = {
  ...identityFields,
  status: Schema.Literal("unknown").annotate({ description: "No terminal exit state was observed." }),
  exitCode: Schema.optionalKey(Schema.Never).annotate({
    description: "Unknown shutdown state cannot report a terminal exit code.",
  }),
};

export const ServiceShutdownObservation = Schema.Union([
  Schema.Struct({
    ...identityFields,
    status: Schema.Literal("exited").annotate({ description: "The daemon reported a terminal exit state." }),
    exitCode: Schema.optionalKey(Schema.Number.check(Schema.isInt())).annotate({
      description: "Daemon-reported integer exit code; omission is not zero or proof of cleanup.",
    }),
    reason: Schema.optionalKey(Schema.Never).annotate({ description: "Exited state has no unknown reason." }),
    diagnostic: Schema.optionalKey(Schema.Never).annotate({
      description: "Exited state has no inspection failure.",
    }),
  }),
  Schema.Struct({
    ...unknownFields,
    reason: Schema.Literals(["container-absent", "state-unavailable", "not-exited"]).annotate({
      description: "The container was absent, its state unavailable, or its state was not terminal.",
    }),
    diagnostic: Schema.optionalKey(Schema.Never).annotate({
      description: "Only inspection failure carries a diagnostic.",
    }),
  }),
  Schema.Struct({
    ...unknownFields,
    reason: Schema.Literal("inspect-failed").annotate({ description: "Container inspection failed." }),
    diagnostic: TaggedErrorJson.annotate({
      description:
        "Canonical sanitized tagged diagnostic; producers must redact secrets and omit raw inspect data.",
    }),
  }),
]).annotate({
  description:
    "Attributed shutdown facts observed before removal, without inferring graceful or forced cleanup.",
});
export type ServiceShutdownObservation = typeof ServiceShutdownObservation.Type;

const shutdownObservations = Schema.optionalKey(Schema.Array(ServiceShutdownObservation)).annotate({
  description: "Observed shutdown facts; providers without observation support may omit this field.",
});

// ==== Provider teardown receipts
// Successful resource actions can carry observations made before removal.

export const FileSyncQuiesceResult = Schema.Struct({
  shutdownObservations,
}).annotate({ description: "Shutdown facts from quiescing file sync writers, without deleting app data." });
export type FileSyncQuiesceResult = typeof FileSyncQuiesceResult.Type;

// ==== Bring-down dispositions and receipts
// What a provider bring-down did to each owned container: stop keeps it, remove deletes it.

export const ContainerDisposition = Schema.Literals(["stop", "remove"]).annotate({
  description: "What bring-down does to each owned container: `stop` keeps it, `remove` deletes it.",
});
export type ContainerDisposition = typeof ContainerDisposition.Type;

export const BringDownOptions = Schema.Union([
  Schema.Struct({
    containers: Schema.Literal("stop").annotate({
      description: "Stop owned containers and keep them with their networks, volumes, and applied state.",
    }),
    volumes: Schema.optionalKey(Schema.Never).annotate({ description: "Stopping removes no volumes." }),
    purgeCaches: Schema.optionalKey(Schema.Never).annotate({ description: "Stopping removes no caches." }),
    removeState: Schema.optionalKey(Schema.Never).annotate({
      description: "Stopping always keeps applied state.",
    }),
  }),
  Schema.Struct({
    containers: Schema.Literal("remove").annotate({
      description: "Remove owned containers and networks.",
    }),
    volumes: Schema.Boolean.annotate({ description: "Also remove app-scoped data volumes." }),
    purgeCaches: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Also remove app-scoped cache volumes.",
    }),
    removeState: Schema.optionalKey(Schema.Boolean).annotate({
      description: "Forget the applied plan afterwards; `false` keeps it. Defaults to forgetting it.",
    }),
  }),
]).annotate({ description: "Container disposition and removal flags for a provider bring-down." });
export type BringDownOptions = typeof BringDownOptions.Type;

export const ContainerBringDownAction = Schema.Literals([
  "stopped",
  "already-stopped",
  "removed",
  "absent",
]).annotate({
  description:
    "What bring-down did to one container: stopped it, found it already stopped, removed it, or found none.",
});
export type ContainerBringDownAction = typeof ContainerBringDownAction.Type;

const containerReceiptFields = {
  service: ServiceName.annotate({ description: "Service the container belongs to." }),
  containerId: Schema.optionalKey(Schema.String).annotate({
    description: "Native container id acted on; omitted when no container was found.",
  }),
  action: ContainerBringDownAction,
};

export const ContainerBringDownReceipt = Schema.Struct(containerReceiptFields).annotate({
  description: "What bring-down did to one owned service container.",
});
export type ContainerBringDownReceipt = typeof ContainerBringDownReceipt.Type;

const containerReceipts = Schema.Array(ContainerBringDownReceipt).annotate({
  description: "One receipt per owned container the bring-down addressed.",
});

export const BringDownOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("stopped").annotate({
      description: "The provider stopped owned containers and kept every resource.",
    }),
    containers: containerReceipts,
    shutdownObservations,
  }),
  Schema.Struct({
    kind: Schema.Literal("removed").annotate({
      description: "The provider removed owned containers and networks, and volumes as requested.",
    }),
    containers: containerReceipts,
    volumesRemoved: VolumeRemovalCounts,
    skipped: OwnedResourcesCleanupResult.fields.skipped,
    shutdownObservations,
  }),
  Schema.Struct({
    kind: Schema.Literal("no-op").annotate({ description: "The provider acted on no resources." }),
    reason: Schema.Literal("no-applied-plan").annotate({
      description: "No applied plan exists for this app.",
    }),
    shutdownObservations,
  }),
]).annotate({ description: "What a provider bring-down did, with optional shutdown observations." });
export type BringDownOutcome = typeof BringDownOutcome.Type;

export const ObservedBringDown = Schema.Struct({
  ...containerReceiptFields,
  shutdownObservations,
}).annotate({
  description: "Result of bringing down one observed service container, with optional shutdown facts.",
});
export type ObservedBringDown = typeof ObservedBringDown.Type;
