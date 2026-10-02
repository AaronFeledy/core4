import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import { DoctorResourceNameQuery } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import {
  type EngineHttpApi,
  type EngineHttpRequest,
  type ProviderErrorContext,
  isSuccessStatus,
} from "./engine-api.ts";

const Labels = Schema.optional(Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.String })));
const Volumes = Schema.Struct({
  Volumes: Schema.NullOr(Schema.Array(Schema.Struct({ Name: Schema.String, Labels }))),
});
const Containers = Schema.Array(Schema.Struct({ Names: Schema.Array(Schema.String), Labels }));

export const inspectEngineResourceNames = (
  api: EngineHttpApi,
  query: DoctorResourceNameQuery,
  ctx: ProviderErrorContext,
) =>
  Effect.gen(function* () {
    const errorFields = { ...ctx, operation: "inspectResourceNames" };
    const checked = yield* Schema.decodeUnknown(DoctorResourceNameQuery)(query).pipe(
      Effect.mapError(
        () => new ProviderInternalError({ ...errorFields, message: "Invalid resource name query." }),
      ),
    );
    if (api.request === undefined) {
      return yield* Effect.fail(
        new ProviderUnavailableError({ ...errorFields, message: "Engine request transport is unavailable." }),
      );
    }
    const filters = encodeURIComponent(
      JSON.stringify({
        ...(checked.namePrefix === undefined ? {} : { name: [checked.namePrefix] }),
        ...(checked.label === undefined ? {} : { label: [`${checked.label.key}=${checked.label.value}`] }),
      }),
    );
    const paths = {
      volume: `/volumes?filters=${filters}`,
      container: `/containers/json?all=true&filters=${filters}`,
    } as const;
    const request: EngineHttpRequest = { method: "GET", path: paths[checked.kind] };
    const response = yield* api.request(request);
    if (!isSuccessStatus(response.status)) {
      return yield* Effect.fail(
        new ProviderUnavailableError({
          ...errorFields,
          message: `Engine resource inspection returned HTTP ${response.status}.`,
        }),
      );
    }
    const malformed = () =>
      new ProviderInternalError({
        ...errorFields,
        message: "Engine resource inspection returned malformed JSON data.",
      });
    const resources = yield* (
      checked.kind === "volume"
        ? Schema.decodeUnknown(Schema.parseJson(Volumes))(response.body).pipe(
            Effect.map((body) =>
              (body.Volumes ?? []).map((volume) => ({ names: [volume.Name], labels: volume.Labels ?? {} })),
            ),
          )
        : Schema.decodeUnknown(Schema.parseJson(Containers))(response.body).pipe(
            Effect.map((body) =>
              body.map((container) => ({
                names: container.Names.map((name) => name.replace(/^\//u, "")),
                labels: container.Labels ?? {},
              })),
            ),
          )
    ).pipe(Effect.mapError(malformed));
    const names = resources
      .filter(
        ({ labels }) =>
          !Object.keys(labels).some((key) => key.startsWith("dev.lando.")) &&
          (checked.label === undefined || labels[checked.label.key] === checked.label.value),
      )
      .flatMap((resource) => resource.names)
      .filter((name) => checked.namePrefix === undefined || name.startsWith(checked.namePrefix));
    return [...new Set(names)].sort().slice(0, checked.limit);
  });
