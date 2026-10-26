import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { AppPlan, AuthoredNetworkPlan } from "@lando/sdk/schema";
import { Effect, Option, Schema } from "effect";
import type { EngineHttpApi, ProviderErrorContext } from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
import { networkLabelsDecision, networkOwnershipLabels } from "../native-ownership.ts";

const NetworkInspection = Schema.fromJsonString(
  Schema.Struct({
    Name: Schema.String,
    Driver: Schema.optionalKey(Schema.String),
    Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
);

const networkFailure = (ctx: ProviderErrorContext, name: string, reason: string, remediation: string) =>
  new ProviderUnavailableError({
    providerId: ctx.providerId,
    operation: "bringUp.network.external",
    message: `Network ${name}: ${reason}`,
    remediation,
  });

export const preflightExternalNetwork = Effect.fnUntraced(function* (
  api: EngineHttpApi,
  name: string,
  ctx: ProviderErrorContext,
) {
  if (api.request === undefined) return yield* Effect.fail(missingApi(ctx, "bringUp.network.external"));
  const remediation = "Start the project that owns this network or create it, then run `lando start` again.";
  const response = yield* api.request({ method: "GET", path: `/networks/${encodeURIComponent(name)}` });
  if (response.status === 404) {
    return yield* Effect.fail(
      networkFailure(ctx, name, "this external network does not exist.", remediation),
    );
  }
  if (response.status !== 200) {
    return yield* Effect.fail(
      networkFailure(ctx, name, `external network inspect returned HTTP ${response.status}.`, remediation),
    );
  }
  const decoded = Schema.decodeUnknownOption(NetworkInspection)(response.body);
  if (Option.isNone(decoded) || decoded.value.Name !== name) {
    return yield* Effect.fail(
      networkFailure(ctx, name, "external network exact name could not be verified.", remediation),
    );
  }
});

export const ensureAuthoredNetwork = Effect.fnUntraced(function* (
  api: EngineHttpApi,
  input: { readonly plan: AppPlan; readonly network: AuthoredNetworkPlan },
  ctx: ProviderErrorContext,
) {
  const { plan, network } = input;
  if (api.request === undefined) return yield* Effect.fail(missingApi(ctx, "bringUp.network"));
  const labels = networkOwnershipLabels(plan);
  const driver = network.driver ?? "bridge";
  const path = `/networks/${encodeURIComponent(network.name)}` as const;
  let inspected = yield* api.request({ method: "GET", path });
  const fail = (reason: string, remediation: string) =>
    Effect.fail(
      new ProviderUnavailableError({
        providerId: ctx.providerId,
        operation: "bringUp.network",
        message: `Network ${network.name}: ${reason}`,
        remediation,
      }),
    );
  const retry = "Inspect the network conflict, then run `lando start` again.";
  if (inspected.status === 404) {
    const created = yield* api.request({
      method: "POST",
      path: "/networks/create",
      body: {
        Name: network.name,
        Driver: driver,
        Labels: labels,
      },
    });
    if (created.status === 200 || created.status === 201) return;
    if (created.status !== 409) return yield* fail(`create returned HTTP ${created.status}.`, retry);
    inspected = yield* api.request({ method: "GET", path });
  }
  if (inspected.status !== 200) return yield* fail(`inspect returned HTTP ${inspected.status}.`, retry);
  const decoded = Schema.decodeUnknownOption(NetworkInspection)(inspected.body);
  if (Option.isNone(decoded) || decoded.value.Name !== network.name) {
    return yield* fail("exact name could not be verified.", retry);
  }
  switch (networkLabelsDecision(decoded.value.Labels ?? undefined, labels)) {
    case "foreign":
      return yield* fail(
        "another project owns this network.",
        `To join it, set \`external: true\` and \`name: ${network.name}\` under networks.${network.key}.`,
      );
    case "legacy":
      return yield* fail(
        "it is not verifiably Lando's network.",
        "Remove or rename the conflicting network, then run `lando start` again.",
      );
    case "owned":
      break;
  }
  if (decoded.value.Driver !== driver) {
    return yield* fail(
      `driver differs from planned driver ${driver}.`,
      "Run `lando destroy`, then `lando start` to recreate the network with the planned driver.",
    );
  }
});
