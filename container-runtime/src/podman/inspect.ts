import { DateTime, Effect, Option, Schema } from "effect";
import { serviceContainerName } from "../plan.ts";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type AppPlan,
  ObservedPublication,
  type PublicationObservation,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo, ServiceSelector } from "@lando/sdk/services";

import { prepareContainerHelperMounts } from "../container-helper-mount.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi, missingService, parseEngineJson } from "../engine-errors.ts";
import type { ExecSupervisionOptions } from "../exec-supervision.ts";
import { APP_ROOT_LABEL } from "../labels.ts";
import { containerOwnershipLabels } from "../native-ownership.ts";
import { fingerprintInspectPublishPorts } from "../plan.ts";
import { redactDetails, redactorFor, withApiReason } from "../redact.ts";
import { runObservationFromInspectState } from "../run-observation.ts";
import {
  inspectBindSources,
  inspectContainerLabels,
  inspectNetworkNames,
  presentLogicalCreateConfig,
} from "./bring-up-recreate.ts";
import { mountObservationFromInspect } from "./inspect-mounts.ts";

interface ContainerInspect {
  readonly Id?: string;
  readonly Image?: string;
  readonly State?: {
    readonly Health?: { readonly Status?: string };
    readonly Running?: boolean;
    readonly Paused?: boolean;
    readonly Restarting?: boolean;
    readonly Status?: string;
    readonly StartedAt?: string;
    readonly ExitCode?: number;
  };
  readonly NetworkSettings?: {
    readonly Ports?: Record<string, Array<{ readonly HostIp?: string; readonly HostPort?: string }> | null>;
  };
}

const PublicationInspect = Schema.Struct({
  NetworkSettings: Schema.Struct({
    Ports: Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.Null,
        Schema.Array(Schema.Struct({ HostIp: Schema.String, HostPort: Schema.String })),
      ]),
    ),
  }),
});

export const publicationObservationFromInspect = (inspect: unknown): PublicationObservation => {
  const decoded = Schema.decodeUnknownOption(PublicationInspect)(inspect);
  if (Option.isNone(decoded)) return { status: "unknown" };
  const bindings: ObservedPublication[] = [];
  for (const [key, values] of Object.entries(decoded.value.NetworkSettings.Ports)) {
    const match = /^(\d+)\/(tcp|udp)$/u.exec(key);
    const port = Number(match?.[1]);
    const transport = match?.[2];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (transport !== "tcp" && transport !== "udp")) {
      return { status: "unknown" };
    }
    for (const value of values ?? []) {
      const binding = {
        port,
        transport,
        bindAddress: value.HostIp === "" ? "0.0.0.0" : value.HostIp,
        hostPort: Number(value.HostPort),
      };
      if (!/^\d+$/u.test(value.HostPort) || !Schema.is(ObservedPublication)(binding)) {
        return { status: "unknown" };
      }
      bindings.push(binding);
    }
  }
  return { status: "present", bindings };
};

export interface InspectOptions
  extends Pick<ExecSupervisionOptions, "resolveContainerHelper" | "helperTarget"> {
  readonly api?: EngineHttpApi;
  readonly ctx: ProviderErrorContext;
}

const containerName = (plan: AppPlan, service: ServicePlan) => serviceContainerName(plan, service.name);

const request = (
  deps: { readonly api: EngineHttpApi; readonly ctx: ProviderErrorContext },
  input: EngineHttpRequest,
  operation: string,
): Effect.Effect<EngineHttpResponse, ProviderError> =>
  deps.api.request === undefined ? Effect.fail(missingApi(deps.ctx, operation)) : deps.api.request(input);

const lastStartedAt = (inspect: ContainerInspect): Date | undefined => {
  const startedAt = inspect.State?.StartedAt;
  if (startedAt === undefined || startedAt.length === 0 || startedAt.startsWith("0001-")) {
    return undefined;
  }
  const parsed = DateTime.make(startedAt);
  return Option.isNone(parsed) ? undefined : DateTime.toDate(parsed.value);
};

export const inspect = Effect.fn("RuntimeProvider.inspect")(function* (
  plan: AppPlan,
  target: ServiceSelector,
  options: InspectOptions,
): Effect.fn.Return<ServiceRuntimeInfo, ProviderError> {
  const ctx = options.ctx;
  const service = plan.services[target.service];
  if (service === undefined) {
    return yield* Effect.fail(missingService(ctx, target, "inspect"));
  }
  if (options.api === undefined) {
    return yield* Effect.fail(missingApi(ctx, "inspect"));
  }

  const deps = { api: options.api, ctx };

  const response = yield* request(
    deps,
    {
      method: "GET",
      path: `/containers/${encodeURIComponent(containerName(plan, service))}/json`,
    },
    "inspect",
  );

  if (response.status === 404) {
    return {
      app: plan.id,
      appRoot: plan.root,
      service: service.name,
      providerId: plan.provider,
      status: "absent",
      publications: { status: "missing" },
      mounts: { status: "missing" },
    };
  }
  if (response.status < 200 || response.status >= 300) {
    yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: ctx.providerId,
        operation: "inspect",
        message: withApiReason(
          `provider-${ctx.providerId} inspect failed with HTTP ${response.status}.`,
          {
            body: response.body,
          },
          redactorFor(ctx),
        ),
        details: redactDetails({ service: service.name, body: response.body }, redactorFor(ctx)),
        remediation: ctx.remediation,
      }),
    );
  }

  const decoded = (yield* parseEngineJson(response, ctx, "inspect")) as ContainerInspect;
  const labels = inspectContainerLabels(decoded);
  const expectedOwnership = containerOwnershipLabels(plan, service.name);
  // Even incoherent labels cannot make an explicitly foreign root this plan's service.
  if (labels[APP_ROOT_LABEL] !== undefined && labels[APP_ROOT_LABEL] !== expectedOwnership[APP_ROOT_LABEL]) {
    return {
      app: plan.id,
      appRoot: plan.root,
      service: service.name,
      providerId: plan.provider,
      status: "unknown",
      publications: { status: "unknown" },
      mounts: { status: "unknown" },
      labels,
    };
  }
  const run = runObservationFromInspectState(decoded.State);
  const startedAt = lastStartedAt(decoded);
  const bindSources = inspectBindSources(decoded);
  const networkNames = inspectNetworkNames(decoded);
  const physical =
    options.resolveContainerHelper === undefined || options.helperTarget === undefined
      ? plan
      : yield* prepareContainerHelperMounts(plan, options);
  return {
    app: plan.id,
    appRoot: plan.root,
    service: service.name,
    providerId: plan.provider,
    ...run,
    ...(typeof decoded.Id === "string" && decoded.Id.length > 0 ? { containerId: decoded.Id } : {}),
    ...(typeof decoded.Image === "string" && decoded.Image.length > 0
      ? { imageIdentity: decoded.Image }
      : {}),
    publications: publicationObservationFromInspect(decoded),
    mounts: mountObservationFromInspect(decoded),
    ...(startedAt === undefined ? {} : { lastStartedAt: startedAt }),
    publishFingerprint: fingerprintInspectPublishPorts(decoded),
    labels: presentLogicalCreateConfig(labels, { physical, logical: plan, service: service.name }),
    ...(bindSources === undefined ? {} : { bindSources }),
    ...(networkNames === undefined ? {} : { networkNames }),
  };
});
