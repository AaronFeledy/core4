import { Schema } from "effect";

import { SchemaNotCredentialAnnotationId } from "./environment-value.ts";
import { FileSyncInfo } from "./file-sync-policy.ts";
import { AppLifecycleEventName } from "./landofile-events.ts";
import { CheckResult } from "./networking.ts";
import { OwnedResourcesCleanupResult } from "./resource-ownership.ts";
import { ServiceInfo, StartedService } from "./service-info.ts";
import { ServiceShutdownObservation } from "./service-shutdown.ts";

// ==== Lifecycle results
// Outcomes returned when an App handle changes its services or resources.

export const LandofileEventsOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ran").annotate({
      description: "The operation ran the Landofile's lifecycle steps.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("skipped").annotate({
      description: "The operation could not source the Landofile's lifecycle steps.",
    }),
    reason: Schema.String.annotate({
      description:
        "Why the steps were skipped: no Landofile at the applied root, a Landofile that failed to load, or one that describes another app or provider.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("failed").annotate({
      description: "The operation completed, but a Landofile step for this event failed.",
    }),
    event: AppLifecycleEventName.pick([
      "post-init",
      "post-start",
      "post-stop",
      "post-restart",
      "post-rebuild",
      "post-destroy",
    ]).annotate({ description: "The lifecycle event whose Landofile step failed." }),
    stepFailure: Schema.Struct({
      _tag: Schema.String.annotate({ description: "Machine-readable error tag for the failed step." }),
      message: Schema.String.annotate({ description: "Redacted explanation of why the step failed." }),
      remediation: Schema.String.annotate({ description: "Suggested action to address the step failure." }),
    }).annotate({ description: "The tagged diagnostic for the failed step." }),
  }),
]).annotate({
  description:
    "Whether the operation ran the Landofile's `events:` and `hostEvents` steps, skipped them, or completed with a failed post-event step.",
});
export type LandofileEventsOutcome = typeof LandofileEventsOutcome.Type;

export const StartAppResult = Schema.Struct({
  credentialChanges: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        service: Schema.String.annotate({ description: "Service whose database credentials were verified." }),
        family: Schema.Literals(["postgres", "mysql", "mariadb", "mongodb", "mssql"]).annotate({
          description: "Database family.",
        }),
        changedMembers: Schema.Array(
          Schema.Literals(["user", "password", "database", "rootPassword"]),
        ).annotate({ description: "Credential members changed without exposing their values." }),
      }),
    ).annotate({ [SchemaNotCredentialAnnotationId]: true }),
  ).annotate({ description: "Verified database credential changes made during activation." }),
  app: Schema.String.annotate({ description: "Name of the started app." }),
  servicesStarted: Schema.Array(StartedService).annotate({
    description: "Services started with their observed endpoints and connections.",
  }),
  checks: Schema.optionalKey(Schema.Array(CheckResult)).annotate({
    description: "Post-start endpoint checks, when scanning was performed.",
  }),
  servicesRemoved: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Names of services whose containers were removed because the Landofile no longer defines them; omitted when a service selection removed nothing.",
  }),
  servicesStayedDown: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Unselected planned services verified absent, exited, created, dead, or paused after a selected start. Omits running, restarting, and unverified services; omitted when empty or on a whole-app start.",
  }),
}).annotate({ description: "Services and optional readiness checks returned after starting an app." });
export type StartAppResult = typeof StartAppResult.Type;

export const StopAppOutcome = Schema.Literals(["stopped", "unchanged"]).annotate({
  description:
    "`stopped` when the operation stopped or removed anything, or `unchanged` when there was nothing to stop.",
});
export type StopAppOutcome = typeof StopAppOutcome.Type;

export const DestroyAppOutcome = Schema.Literals(["destroyed", "unchanged"]).annotate({
  description:
    "`destroyed` when the operation removed anything, or `unchanged` when there was nothing to remove.",
});
export type DestroyAppOutcome = typeof DestroyAppOutcome.Type;

export const StopAppResult = Schema.Struct({
  app: Schema.String.annotate({
    description: "Name of the stopped app; when only applied state remains, its app id or root.",
  }),
  outcome: Schema.optionalKey(StopAppOutcome),
  runtimeState: Schema.optionalKey(Schema.Literals(["idle", "running"])).annotate({
    description: "Provider runtime state observed before stopping the app, when known.",
  }),
  servicesStopped: Schema.Array(Schema.String).annotate({
    description: "Names of the services stopped by the operation.",
  }),
  shutdownObservations: Schema.optionalKey(Schema.Array(ServiceShutdownObservation)).annotate({
    description: "Attributed daemon shutdown facts, when the provider supports observation.",
  }),
  landofileEvents: Schema.optionalKey(LandofileEventsOutcome).annotate({
    description: "Lifecycle-step outcome when the app teardown could run Landofile events.",
  }),
}).annotate({ description: "Service teardown and lifecycle-step outcomes returned after stopping an app." });
export type StopAppResult = typeof StopAppResult.Type;

export const RestartAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the restarted app." }),
  servicesStarted: StartAppResult.fields.servicesStarted,
  checks: StartAppResult.fields.checks,
  credentialChanges: StartAppResult.fields.credentialChanges,
  servicesRemoved: StartAppResult.fields.servicesRemoved,
}).annotate({ description: "Services and optional readiness checks returned after restarting an app." });
export type RestartAppResult = typeof RestartAppResult.Type;

export const RebuildAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the rebuilt app." }),
  servicesRebuilt: Schema.Array(Schema.String).annotate({
    description: "Names of the services rebuilt by the operation.",
  }),
  servicesStarted: StartAppResult.fields.servicesStarted,
  checks: StartAppResult.fields.checks,
  credentialChanges: StartAppResult.fields.credentialChanges,
  servicesRemoved: StartAppResult.fields.servicesRemoved,
}).annotate({
  description: "Rebuilt services and their post-start observations returned after rebuilding an app.",
});
export type RebuildAppResult = typeof RebuildAppResult.Type;

export const BuiltImageCleanup = Schema.Struct({
  removed: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Number of built images removed.",
  }),
  released: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Number of built images retained for reuse after releasing their owner.",
  }),
  inUse: Schema.Array(
    Schema.Struct({
      ref: Schema.String.annotate({ description: "Image name or ID retained because it is in use." }),
      containers: Schema.Array(Schema.String).annotate({
        description: "Names of containers using the image; may be empty.",
      }),
      reason: Schema.String.annotate({
        description: "The runtime's explanation of what still uses the image.",
      }),
    }),
  ).annotate({ description: "Built images retained because they are in use." }),
}).annotate({ description: "Built-image cleanup and retention outcomes." });
export type BuiltImageCleanup = typeof BuiltImageCleanup.Type;

export const DestroyAppResult = Schema.Struct({
  skipped: OwnedResourcesCleanupResult.fields.skipped,
  app: Schema.String.annotate({
    description: "Name of the destroyed app; when only applied state remains, its app id or root.",
  }),
  outcome: Schema.optionalKey(DestroyAppOutcome),
  servicesDestroyed: Schema.Array(Schema.String).annotate({
    description: "Names of the services destroyed by the operation.",
  }),
  dataVolumesRemoved: Schema.Boolean.annotate({
    description:
      "Whether the operation actually removed at least one of the app's named data volumes; not proof that every data volume is gone.",
  }),
  cacheVolumesRemoved: Schema.Boolean.annotate({
    description:
      "Whether the operation actually removed at least one of the app's named cache volumes; not proof that every cache volume is gone.",
  }),
  snapshotsRemoved: Schema.Number.annotate({
    description:
      "Number of app snapshots removed; only a snapshot purge (`lando destroy --purge`) removes them.",
  }),
  landofileEvents: StopAppResult.fields.landofileEvents,
  shutdownObservations: StopAppResult.fields.shutdownObservations,
  builtImages: Schema.optionalKey(BuiltImageCleanup).annotate({
    description: "Built-image cleanup outcomes, when cleanup was attempted.",
  }),
}).annotate({
  description: "Resources removed and lifecycle-step outcomes returned after destroying an app.",
});
export type DestroyAppResult = typeof DestroyAppResult.Type;

// ==== Introspection results
// Observed services and host integration available to an App handle.

export const InfoAppAgentEnv = Schema.Struct({
  enabled: Schema.Boolean.annotate({
    description: "Whether agent environment forwarding is enabled for this app.",
  }),
  forwarded: Schema.Array(Schema.String).annotate({
    description: "Names of the environment variables forwarded into services.",
  }),
}).annotate({ description: "Agent environment forwarding reported by app introspection." });
export type InfoAppAgentEnv = typeof InfoAppAgentEnv.Type;

export const InfoAppHostProxy = Schema.Struct({
  runLando: Schema.Struct({
    availability: Schema.Literals(["available", "unavailable"]).annotate({
      description:
        "Whether the selected services have a configured, provider-supported Lando command bridge; not worker health.",
    }),
    reason: Schema.optionalKey(Schema.String).annotate({
      description: "Explanation of host-proxy command availability.",
    }),
  }).annotate({ description: "Availability of the in-container Lando command bridge." }),
}).annotate({
  description: "Configured host-proxy capability for selected eligible services, not worker liveness.",
});
export type InfoAppHostProxy = typeof InfoAppHostProxy.Type;

/**
 * Filesystem applied-state observation for `lando info`. Distinct from service runtime status:
 * a newer or damaged record is unknown with a version/unreadable diagnosis, never silent absence.
 */
const infoAppliedStateIssueFields = {
  path: Schema.String.annotate({ description: "Path to the applied-state file." }),
  message: Schema.String.annotate({ description: "Why Lando could not read the applied state." }),
  remediation: Schema.String.annotate({ description: "How to recover from the reported issue." }),
};

export const InfoAppliedStateIssue = Schema.Union([
  Schema.Struct({
    ...infoAppliedStateIssueFields,
    reason: Schema.Literal("unreadable").annotate({ description: "The applied state could not be read." }),
  }),
  Schema.Struct({
    ...infoAppliedStateIssueFields,
    reason: Schema.Literal("newer-version").annotate({
      description: "A newer Lando wrote this applied state.",
    }),
    storedVersion: Schema.Int.annotate({ description: "Applied-state format version stored on disk." }),
    supportedVersion: Schema.Int.annotate({
      description: "Applied-state format version this Lando supports.",
    }),
    writtenBy: Schema.optionalKey(
      Schema.String.annotate({ description: "Lando version that wrote the record, when recorded." }),
    ),
  }),
]).annotate({
  description:
    "A diagnosis for applied provider state that Lando leaves in place because it cannot read it safely.",
});
export type InfoAppliedStateIssue = typeof InfoAppliedStateIssue.Type;

export const InfoAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the inspected app." }),
  dataName: Schema.optionalKey(Schema.String).annotate({
    description:
      "Original name used by this folder's persisted data, present when it differs from the app name.",
  }),
  services: Schema.Array(ServiceInfo).annotate({
    description: "Observed service status, endpoints, and connection metadata.",
  }),
  agentEnv: Schema.optionalKey(InfoAppAgentEnv).annotate({
    description: "Agent environment forwarding details, when configured.",
  }),
  hostProxy: Schema.optionalKey(InfoAppHostProxy).annotate({
    description:
      "In-container Lando command capability, present only when a selected service is host-proxy eligible; not worker health.",
  }),
  fileSync: Schema.optionalKey(FileSyncInfo).annotate({
    description: "File synchronization status, when available.",
  }),
  appliedStateIssue: Schema.optionalKey(InfoAppliedStateIssue).annotate({
    description: "Present only when Lando cannot safely read this app's applied-state record.",
  }),
}).annotate({ description: "Service and host-integration observations returned when inspecting an app." });
export type InfoAppResult = typeof InfoAppResult.Type;

// ==== Command execution results
// Captured process results from service execution and named tooling.

export const ExecAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the app where the command ran." }),
  service: Schema.String.annotate({ description: "Service that executed the command." }),
  command: Schema.Array(Schema.String).annotate({
    description: "Executed command and its ordered arguments.",
  }),
  exitCode: Schema.Number.annotate({ description: "Exit code returned by the command process." }),
  stdout: Schema.optionalKey(Schema.String).annotate({
    description:
      "Captured standard output, including an empty string for an empty capture; omitted when a live sink received the bytes.",
  }),
  stderr: Schema.optionalKey(Schema.String).annotate({
    description:
      "Captured standard error, including an empty string for an empty capture; omitted when a live sink received the bytes.",
  }),
}).annotate({
  description: "Captured output and exit status returned after executing a command in an app service.",
});
export type ExecAppResult = typeof ExecAppResult.Type;

export const ToolingResult = Schema.Struct({
  tool: Schema.String.annotate({ description: "Identifier of the tooling task that ran." }),
  service: Schema.String.annotate({ description: "Service that executed the tooling task." }),
  exitCode: Schema.Number.annotate({ description: "Exit code returned by the tooling task." }),
  stdout: ExecAppResult.fields.stdout,
  stderr: ExecAppResult.fields.stderr,
}).annotate({ description: "Captured output and exit status returned after invoking an app tooling task." });
export type ToolingResult = typeof ToolingResult.Type;
