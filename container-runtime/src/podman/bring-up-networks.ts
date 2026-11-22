import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, type AuthoredNetworkPlan, LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Effect, Option, Schema } from "effect";
import { ownsSharedCrossAppNetwork } from "../data-root-labels.ts";
import { type AdoptionReceipt, dataRootRefusal, decideDataRootOwnership } from "../data-root-ownership.ts";
import type {
  EngineHttpApi,
  EngineHttpRequest,
  EngineHttpResponse,
  ProviderErrorContext,
} from "../engine-api.ts";
import { missingApi } from "../engine-errors.ts";
import { matchesPrivateNetworkLabels, networkOwnershipLabels } from "../native-ownership.ts";

const NetworkInspection = Schema.fromJsonString(
  Schema.Struct({
    Name: Schema.String,
    Driver: Schema.optionalKey(Schema.String),
    Labels: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
    Id: Schema.optionalKey(Schema.Unknown),
    ID: Schema.optionalKey(Schema.Unknown),
    id: Schema.optionalKey(Schema.Unknown),
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
  dataRoot?: string,
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
  const owner = decoded.value.Labels?.[LANDO_DATA_ROOT_LABEL];
  if (owner !== undefined && owner !== dataRoot) {
    return yield* new ProviderUnavailableError({
      providerId: ctx.providerId,
      operation: "bringUp.network.external",
      ...dataRootRefusal({ kind: "network", nativeName: name, labels: decoded.value.Labels }),
    });
  }
});

export const ensurePrivateNetwork = Effect.fnUntraced(function* (
  request: (request: EngineHttpRequest) => Effect.Effect<EngineHttpResponse, ProviderError>,
  input: {
    readonly plan: AppPlan;
    readonly name: string;
    readonly driver: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly sharedDataRoot?: string;
    readonly adoptionReceipts?: readonly AdoptionReceipt[] | undefined;
    readonly create: (
      labels: Readonly<Record<string, string>>,
    ) => Effect.Effect<EngineHttpResponse, ProviderError>;
    readonly conflictRemediation?: string;
    readonly createFailure?: (response: EngineHttpResponse) => ProviderUnavailableError;
  },
  ctx: ProviderErrorContext,
) {
  const { plan, name, driver } = input;
  const labels: Readonly<Record<string, string>> = input.labels ?? networkOwnershipLabels(plan);
  const path = `/networks/${encodeURIComponent(name)}` as const;
  let inspected = yield* request({ method: "GET", path });
  const fail = (reason: string, remediation: string) =>
    Effect.fail(
      new ProviderUnavailableError({
        providerId: ctx.providerId,
        operation: "bringUp.network",
        message: `Network ${name}: ${reason}`,
        remediation,
      }),
    );
  const retry = "Inspect the network conflict, then run `lando start` again.";
  if (inspected.status === 404) {
    const created = yield* input.create(labels);
    const createdNow = created.status === 200 || created.status === 201;
    if (createdNow && input.sharedDataRoot === undefined) return;
    if (!createdNow && created.status !== 409) {
      if (input.createFailure !== undefined) return yield* Effect.fail(input.createFailure(created));
      return yield* fail(`create returned HTTP ${created.status}.`, retry);
    }
    inspected = yield* request({ method: "GET", path });
  }
  if (inspected.status !== 200) return yield* fail(`inspect returned HTTP ${inspected.status}.`, retry);
  const decoded = Schema.decodeUnknownOption(NetworkInspection)(inspected.body);
  if (Option.isNone(decoded) || decoded.value.Name !== name) {
    return yield* fail("exact name could not be verified.", retry);
  }
  const nativeId = decoded.value.Id ?? decoded.value.ID ?? decoded.value.id;
  if (typeof nativeId !== "string" || nativeId.length === 0)
    return yield* fail("native ID could not be verified.", retry);
  const actual = decoded.value.Labels ?? {};
  const dataRoot = labels[LANDO_DATA_ROOT_LABEL];
  const resource = { kind: "network", nativeName: name, nativeId, labels: actual } as const;
  if (
    dataRoot !== undefined &&
    decideDataRootOwnership(resource, {
      dataRoot,
      receipts: input.sharedDataRoot === undefined ? (input.adoptionReceipts ?? []) : [],
    }) !== "owned"
  ) {
    return yield* new ProviderUnavailableError({
      providerId: ctx.providerId,
      operation: "bringUp.network",
      ...dataRootRefusal(resource),
    });
  }
  if (Object.keys(actual).length === 0) {
    return yield* fail(
      "it is not verifiably Lando's network.",
      "Remove or rename the conflicting network, then run `lando start` again.",
    );
  }
  if (
    (dataRoot === undefined && actual[LANDO_DATA_ROOT_LABEL] !== undefined) ||
    (input.sharedDataRoot === undefined
      ? !matchesPrivateNetworkLabels(actual, labels)
      : !ownsSharedCrossAppNetwork(input.sharedDataRoot, name, actual))
  ) {
    return yield* fail("another project owns this network.", input.conflictRemediation ?? retry);
  }
  if (decoded.value.Driver !== driver) {
    return yield* fail(
      `driver differs from planned driver ${driver}.`,
      "Run `lando destroy`, then `lando start` to recreate the network with the planned driver.",
    );
  }
  return nativeId;
});

export const ensureAuthoredNetwork = Effect.fnUntraced(function* (
  api: EngineHttpApi,
  input: {
    readonly plan: AppPlan;
    readonly network: AuthoredNetworkPlan;
    readonly adoptionReceipts?: readonly AdoptionReceipt[] | undefined;
  },
  ctx: ProviderErrorContext,
) {
  if (api.request === undefined) return yield* Effect.fail(missingApi(ctx, "bringUp.network"));
  const { plan, network } = input;
  const driver = network.driver ?? "bridge";
  const request = api.request;
  return yield* ensurePrivateNetwork(
    request,
    {
      plan,
      adoptionReceipts: input.adoptionReceipts,
      name: network.name,
      driver,
      conflictRemediation: `To join it, set \`external: true\` and \`name: ${network.name}\` under networks.${network.key}.`,
      create: (labels) =>
        request({
          method: "POST",
          path: "/networks/create",
          body: { Name: network.name, Driver: driver, Labels: labels },
        }),
    },
    ctx,
  );
});
