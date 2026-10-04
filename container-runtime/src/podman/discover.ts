import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ProviderError, ServiceRuntimeInfo } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import { engineApiFailure, missingApi, parseEngineJson } from "../engine-errors.ts";
import { APP_LABEL, APP_ROOT_LABEL, SERVICE_LABEL } from "../labels.ts";
import { redactDetails, withApiReason } from "../redact.ts";

const Containers = Schema.Array(
  Schema.Struct({
    Id: Schema.String,
    State: Schema.optionalKey(Schema.String),
    Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

export const discoverLabeledContainers = Effect.fn("RuntimeProvider.discover")(function* (
  api: EngineHttpApi | undefined,
  ctx: ProviderErrorContext,
): Effect.fn.Return<ReadonlyArray<ServiceRuntimeInfo>, ProviderError> {
  const request = api?.request;
  if (request === undefined) {
    return yield* Effect.fail(
      missingApi(ctx, "list", `provider-${ctx.providerId} list requires an engine API client.`),
    );
  }
  const query = new URLSearchParams({ all: "true", filters: JSON.stringify({ label: [APP_LABEL] }) });
  const input = { method: "GET", path: `/containers/json?${query}` } as const;

  const response = yield* request(input).pipe(
    Effect.mapError((cause) => engineApiFailure(ctx, "list", input, cause)),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: ctx.providerId,
        operation: "list",
        message: withApiReason(
          `provider-${ctx.providerId} list failed with HTTP ${response.status}.`,
          response,
        ),
        details: redactDetails(response),
        remediation: ctx.remediation,
      }),
    );
  }
  const decoded = yield* parseEngineJson(response, ctx, "list");
  const containers = yield* Schema.decodeUnknownEffect(Containers)(decoded).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderInternalError({
          providerId: ctx.providerId,
          operation: "list",
          message: "Container engine returned an invalid container list.",
          remediation: ctx.remediation,
          cause,
        }),
    ),
  );
  return containers.flatMap((container): ReadonlyArray<ServiceRuntimeInfo> => {
    const labels = container.Labels ?? {};
    const app = labels[APP_LABEL];
    const service = labels[SERVICE_LABEL];
    if (app === undefined || service === undefined) return [];
    const appRoot = labels[APP_ROOT_LABEL];
    return [
      {
        providerId: ProviderId.make(ctx.providerId),
        app: AppId.make(app),
        ...(appRoot === undefined ? {} : { appRoot: AbsolutePath.make(appRoot) }),
        service: ServiceName.make(service),
        containerId: container.Id,
        status: container.State === "running" ? "running" : "stopped",
        labels,
      },
    ];
  });
});

/**
 * A container's own `dev.lando.app-root` label is the ownership record: an interrupted apply from
 * another folder can recreate a planned app's same-named container before its plan is saved. When
 * a planned observation and a discovered one share a container id, the label's root wins.
 */
export const labelOwnedSnapshots = (
  planned: ReadonlyArray<ServiceRuntimeInfo>,
  discovered: ReadonlyArray<ServiceRuntimeInfo>,
): ReadonlyArray<ServiceRuntimeInfo> => {
  const labeledRoots = new Map(
    discovered.flatMap((snapshot) =>
      snapshot.containerId === undefined || snapshot.appRoot === undefined
        ? []
        : [[snapshot.containerId, snapshot.appRoot] as const],
    ),
  );
  return planned.map((snapshot) => {
    const labeled = snapshot.containerId === undefined ? undefined : labeledRoots.get(snapshot.containerId);
    return labeled === undefined || labeled === snapshot.appRoot
      ? snapshot
      : { ...snapshot, appRoot: labeled };
  });
};

export const mergeDiscoveredContainers = (
  planned: ReadonlyArray<ServiceRuntimeInfo>,
  discovered: ReadonlyArray<ServiceRuntimeInfo>,
  includeScratch: boolean,
): ReadonlyArray<ServiceRuntimeInfo> => {
  const owned = labelOwnedSnapshots(planned, discovered);
  const reported = new Set(owned.map((snapshot) => snapshot.containerId));
  return [
    ...owned,
    ...discovered.filter(
      (snapshot) =>
        !reported.has(snapshot.containerId) &&
        (includeScratch || snapshot.labels?.["dev.lando.scratch"] !== "TRUE"),
    ),
  ];
};
