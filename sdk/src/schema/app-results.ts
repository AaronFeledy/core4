import { Schema } from "effect";

import { FileSyncInfo } from "./file-sync-policy.ts";
import { CheckResult } from "./networking.ts";
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
]).annotate({
  description:
    "Whether the operation ran the Landofile's `events:` and `hostEvents` steps, or why it skipped them.",
});
export type LandofileEventsOutcome = typeof LandofileEventsOutcome.Type;

export const StartAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the started app." }),
  servicesStarted: Schema.Array(StartedService).annotate({
    description: "Services started with their observed endpoints and connections.",
  }),
  checks: Schema.optionalKey(Schema.Array(CheckResult)).annotate({
    description: "Post-start endpoint checks, when scanning was performed.",
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
}).annotate({ description: "Services and optional readiness checks returned after restarting an app." });
export type RestartAppResult = typeof RestartAppResult.Type;

export const RebuildAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the rebuilt app." }),
  servicesRebuilt: Schema.Array(Schema.String).annotate({
    description: "Names of the services rebuilt by the operation.",
  }),
  servicesStarted: StartAppResult.fields.servicesStarted,
  checks: StartAppResult.fields.checks,
}).annotate({
  description: "Rebuilt services and their post-start observations returned after rebuilding an app.",
});
export type RebuildAppResult = typeof RebuildAppResult.Type;

export const DestroyAppResult = Schema.Struct({
  app: Schema.String.annotate({
    description: "Name of the destroyed app; when only applied state remains, its app id or root.",
  }),
  outcome: Schema.optionalKey(DestroyAppOutcome),
  servicesDestroyed: Schema.Array(Schema.String).annotate({
    description: "Names of the services destroyed by the operation.",
  }),
  volumesRemoved: Schema.Boolean.annotate({
    description: "Whether the operation removed the app's named volumes.",
  }),
  snapshotsRemoved: Schema.Number.annotate({
    description:
      "Number of app snapshots removed; only a snapshot purge (`lando destroy --purge`) removes them.",
  }),
  landofileEvents: StopAppResult.fields.landofileEvents,
  shutdownObservations: StopAppResult.fields.shutdownObservations,
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

export const InfoAppResult = Schema.Struct({
  app: Schema.String.annotate({ description: "Name of the inspected app." }),
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
