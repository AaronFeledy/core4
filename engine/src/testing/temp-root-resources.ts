import {
  type EngineHttpApi,
  type EngineHttpRequest,
  type ProviderErrorContext,
  isSuccessStatus,
} from "@lando/container-runtime/engine-api";
import { encodeEngineFilters } from "@lando/container-runtime/engine-json";
import { listContainerArtifacts } from "@lando/container-runtime/image-list";
import { APP_ROOT_LABEL } from "@lando/container-runtime/labels";
import { ownsSharedCrossAppNetwork } from "@lando/container-runtime/native-ownership";
import { VOLUME_OWNER_LABEL } from "@lando/container-runtime/volume-ownership";
import { ProviderInternalError } from "@lando/sdk/errors";
import { LANDO_DATA_ROOT_LABEL, landoSharedCrossAppNetworkName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { BUILT_ARTIFACT_STORE_LABEL } from "../services/build-artifact-name.ts";
import { retirementFailures } from "./temp-root-failure.ts";

const Labels = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)));
const NamedResource = Schema.Struct({ Name: Schema.NonEmptyString, Labels });
const NetworkInspection = Schema.fromJsonString(
  Schema.Struct({
    ...NamedResource.fields,
    Id: Schema.NonEmptyString,
    Containers: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const Containers = Schema.fromJsonString(Schema.Array(Schema.Struct({ Id: Schema.NonEmptyString, Labels })));
const Networks = Schema.fromJsonString(Schema.Array(NamedResource));
const Volumes = Schema.fromJsonString(Schema.Struct({ Volumes: Schema.NullOr(Schema.Array(NamedResource)) }));

type ResourceScope = {
  readonly api: EngineHttpApi;
  readonly context: ProviderErrorContext;
  readonly dataRoot: string;
  readonly store: string;
};

export const listStoreImages = ({ api, context, store }: Pick<ResourceScope, "api" | "context" | "store">) =>
  listContainerArtifacts(api, { labels: { [BUILT_ARTIFACT_STORE_LABEL]: store } }, context, { all: true });

export const engineRequest = (
  { api, context }: Pick<ResourceScope, "api" | "context">,
  input: EngineHttpRequest,
  allowAbsent = false,
) => {
  const failure = (message: string) =>
    new ProviderInternalError({
      providerId: context.providerId,
      operation: "retireTempRootResources",
      message,
      remediation: context.remediation,
    });
  if (api.request === undefined) return Effect.fail(failure("Engine request transport is unavailable."));
  return api
    .request(input)
    .pipe(
      Effect.flatMap((response) =>
        isSuccessStatus(response.status) || (allowAbsent && response.status === 404)
          ? Effect.succeed(response)
          : Effect.fail(
              failure(`${input.method} ${input.path.split("?")[0]} returned HTTP ${response.status}.`),
            ),
      ),
    );
};

export const retireSharedNetwork = Effect.fnUntraced(function* (scope: ResourceScope) {
  const target = landoSharedCrossAppNetworkName(scope.dataRoot);
  const retained = (reason: string) => ({ retained: [{ target, reason }], removed: [], failed: [] });
  return yield* Effect.gen(function* () {
    const inspected = yield* engineRequest(
      scope,
      { method: "GET", path: `/networks/${encodeURIComponent(target)}` },
      true,
    );
    if (inspected.status === 404) return { retained: [], removed: [], failed: [] };
    const network = yield* Schema.decodeUnknownEffect(NetworkInspection)(inspected.body);
    if (!ownsSharedCrossAppNetwork(scope.dataRoot, network.Name, network.Labels)) {
      return retained("Shared network name or ownership labels do not match (foreign or unlabeled network).");
    }
    const endpoints = Object.keys(network.Containers ?? {});
    if (endpoints.length > 0)
      return retained(`Shared network has attached endpoints: ${endpoints.join(", ")}.`);

    const deleted = yield* engineRequest(
      scope,
      { method: "DELETE", path: `/networks/${encodeURIComponent(network.Id)}` },
      true,
    );
    return { retained: [], removed: deleted.status === 404 ? [] : [target], failed: [] };
  }).pipe(
    Effect.timeout("30 seconds"),
    retirementFailures(target),
    Effect.catch((error) => Effect.succeed({ retained: [], removed: [], failed: [error] })),
  );
});

const rootFilter = (scope: ResourceScope) =>
  encodeEngineFilters({ label: [`${LANDO_DATA_ROOT_LABEL}=${scope.dataRoot}`] });
const matchesRoot = (scope: ResourceScope, resource: { readonly Labels?: typeof Labels.Type }) =>
  resource.Labels?.[LANDO_DATA_ROOT_LABEL] === scope.dataRoot;

export const ownedAppRoots = Effect.fnUntraced(function* (scope: ResourceScope) {
  const filters = rootFilter(scope);
  const containers = yield* engineRequest(scope, {
    method: "GET",
    path: `/containers/json?all=true&filters=${filters}`,
  }).pipe(Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Containers)(body)));
  const volumes = yield* engineRequest(scope, { method: "GET", path: `/volumes?filters=${filters}` }).pipe(
    Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Volumes)(body)),
  );
  return new Set(
    [
      ...containers.filter((row) => matchesRoot(scope, row)).map(({ Labels }) => Labels?.[APP_ROOT_LABEL]),
      ...(volumes.Volumes ?? [])
        .filter((row) => matchesRoot(scope, row))
        .map(({ Labels }) => Labels?.[VOLUME_OWNER_LABEL]),
    ].filter((root): root is string => root !== undefined),
  );
});

export const verifyRootResourcesAbsent = Effect.fnUntraced(function* (scope: ResourceScope) {
  const filters = rootFilter(scope);
  const get = (path: EngineHttpRequest["path"]) => engineRequest(scope, { method: "GET", path });
  const owns = (resource: { readonly Labels?: typeof Labels.Type }) => matchesRoot(scope, resource);
  const checks = {
    container: get(`/containers/json?all=true&filters=${filters}`).pipe(
      Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Containers)(body)),
      Effect.map((rows) => rows.filter(owns).map(({ Id }) => Id)),
    ),
    network: get(`/networks?filters=${filters}`).pipe(
      Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Networks)(body)),
      Effect.map((rows) => rows.filter(owns).map(({ Name }) => Name)),
    ),
    volume: get(`/volumes?filters=${filters}`).pipe(
      Effect.flatMap(({ body }) => Schema.decodeUnknownEffect(Volumes)(body)),
      Effect.map(({ Volumes }) => (Volumes ?? []).filter(owns).map(({ Name }) => Name)),
    ),
    image: listStoreImages(scope).pipe(Effect.map((rows) => rows.map(({ id }) => id))),
  };
  const reports = yield* Effect.forEach(
    Object.entries(checks),
    ([kind, check]) =>
      check.pipe(
        Effect.timeout("30 seconds"),
        retirementFailures(`${kind} verification`),
        Effect.map((remaining) => ({
          retained: remaining.map((target) => ({
            target,
            reason: `Owned ${kind} remains after retirement.`,
          })),
          failed: [],
        })),
        Effect.catch((error) => Effect.succeed({ retained: [], failed: [error] })),
      ),
    { concurrency: "unbounded" },
  );
  return {
    retained: reports.flatMap(({ retained }) => retained),
    failed: reports.flatMap(({ failed }) => failed),
  };
});
