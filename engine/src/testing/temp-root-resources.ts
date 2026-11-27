import {
  type EngineHttpApi,
  type ProviderErrorContext,
  isSuccessStatus,
} from "@lando/container-runtime/engine-api";
import { encodeEngineFilters } from "@lando/container-runtime/engine-json";
import { listContainerArtifacts } from "@lando/container-runtime/image-list";
import { ProviderInternalError } from "@lando/sdk/errors";
import { LANDO_DATA_ROOT_LABEL } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { BUILT_ARTIFACT_STORE_LABEL } from "../services/build-artifact-name.ts";
import { retirementFailures } from "./temp-root-failure.ts";

const Labels = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)));
const Containers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.NonEmptyString,
      Names: Schema.optionalKey(Schema.Array(Schema.String)),
      Labels,
    }),
  ),
);
const Networks = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ Id: Schema.NonEmptyString, Name: Schema.NonEmptyString, Labels })),
);
const Volumes = Schema.fromJsonString(
  Schema.Struct({
    Volumes: Schema.NullOr(Schema.Array(Schema.Struct({ Name: Schema.NonEmptyString, Labels }))),
  }),
);

type ResourceScope = {
  readonly api: EngineHttpApi;
  readonly context: ProviderErrorContext;
  readonly dataRoot: string;
  readonly store: string;
};

export const rootResourceLists = ({ api, context, dataRoot, store }: ResourceScope) => {
  const get = (path: `/${string}`) => {
    const failure = (message: string) =>
      new ProviderInternalError({
        providerId: context.providerId,
        operation: "listTempRootResources",
        message,
        remediation: context.remediation,
      });
    if (api.request === undefined) return Effect.fail(failure("Engine request transport is unavailable."));
    return api
      .request({ method: "GET", path })
      .pipe(
        Effect.flatMap((response) =>
          isSuccessStatus(response.status)
            ? Effect.succeed(response.body)
            : Effect.fail(failure(`GET ${path.split("?")[0]} returned HTTP ${response.status}.`)),
        ),
      );
  };
  const filters = encodeEngineFilters({ label: [`${LANDO_DATA_ROOT_LABEL}=${dataRoot}`] });
  const owns = (resource: { readonly Labels?: typeof Labels.Type }) =>
    resource.Labels?.[LANDO_DATA_ROOT_LABEL] === dataRoot;
  return {
    container: get(`/containers/json?all=true&filters=${filters}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Containers)),
      Effect.map((rows) => rows.filter(owns).map(({ Id, Names }) => ({ id: Id, names: Names ?? [] }))),
    ),
    network: get(`/networks?filters=${filters}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Networks)),
      Effect.map((rows) => rows.filter(owns).map(({ Id, Name }) => ({ id: Id, name: Name }))),
    ),
    volume: get(`/volumes?filters=${filters}`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Volumes)),
      Effect.map(({ Volumes }) => (Volumes ?? []).filter(owns).map(({ Name }) => ({ id: Name }))),
    ),
    image: listContainerArtifacts(api, { labels: { [BUILT_ARTIFACT_STORE_LABEL]: store } }, context, {
      all: true,
    }),
  };
};

export const verifyRootResourcesAbsent = Effect.fnUntraced(function* (scope: ResourceScope) {
  const checks: ReadonlyArray<readonly [string, Effect.Effect<readonly { readonly id: string }[], unknown>]> =
    Object.entries(rootResourceLists(scope));
  const reports = yield* Effect.forEach(
    checks,
    ([kind, check]) =>
      check.pipe(
        Effect.timeout("30 seconds"),
        retirementFailures(`${kind} verification`),
        Effect.map((remaining) => ({
          retained: remaining.map(({ id: target }) => ({
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
