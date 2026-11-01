import { Schema } from "effect";

import { TaggedErrorJson } from "./machine-output.ts";
import { AppId, ProviderId, ServiceName } from "./primitives.ts";

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

export const DestroyOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("destroyed").annotate({ description: "The provider destroyed applied resources." }),
    shutdownObservations,
  }),
  Schema.Struct({
    kind: Schema.Literal("no-op").annotate({ description: "The provider removed no applied resources." }),
    reason: Schema.Literal("no-applied-plan").annotate({
      description: "No applied plan exists for this app.",
    }),
    shutdownObservations,
  }),
]).annotate({ description: "What provider destroy actually removed, with optional shutdown observations." });
export type DestroyOutcome = typeof DestroyOutcome.Type;

export const ObservedServiceRemoval = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("removed").annotate({ description: "The exact observed container was removed." }),
    shutdownObservations,
  }),
  Schema.Struct({
    kind: Schema.Literal("absent").annotate({
      description: "The exact observed container was already absent.",
    }),
    shutdownObservations,
  }),
]).annotate({
  description: "Result of removing an observed service container, with optional shutdown facts.",
});
export type ObservedServiceRemoval = typeof ObservedServiceRemoval.Type;
