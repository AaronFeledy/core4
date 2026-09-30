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
    State: Schema.optional(Schema.String),
    Labels: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  }),
);

export const discoverLabeledContainers = (
  api: EngineHttpApi | undefined,
  ctx: ProviderErrorContext,
): Effect.Effect<ReadonlyArray<ServiceRuntimeInfo>, ProviderError> => {
  const request = api?.request;
  if (request === undefined) {
    return Effect.fail(
      missingApi(ctx, "list", `provider-${ctx.providerId} list requires an engine API client.`),
    );
  }
  const query = new URLSearchParams({ all: "true", filters: JSON.stringify({ label: [APP_LABEL] }) });
  const input = { method: "GET", path: `/containers/json?${query}` } as const;
  return Effect.gen(function* () {
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
    const containers = yield* Schema.decodeUnknown(Containers)(decoded).pipe(
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
};
