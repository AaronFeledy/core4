import { makeSourceStore } from "@lando/source-acquisition";
import { withTestSources } from "@lando/source-acquisition/testing";
import { type Effect, Option, Schema } from "effect";
import type { acquireBuildTrees } from "../services/build-source-store.ts";
import { httpJsonFetch } from "../services/json-fetch.ts";

const registry = "https://registry.npmjs.org";
const Packument = Schema.Struct({
  versions: Schema.Record(
    Schema.String,
    Schema.Struct({
      dist: Schema.Struct({
        tarball: Schema.String,
        integrity: Schema.optionalKey(Schema.String),
        shasum: Schema.optionalKey(Schema.String),
      }),
    }),
  ),
});

export const withRegistryBuildSources = <A, E>(
  body: (store: Parameters<typeof acquireBuildTrees>[1]) => Effect.Effect<A, E>,
) =>
  withTestSources({}, ({ stateStore }) =>
    body(
      Option.some(
        makeSourceStore({
          stateStore,
          transports: {
            npmRegistry: {
              registryFor: () => registry,
              packument: async (name, options) => {
                const response = await httpJsonFetch(`${registry}/${encodeURIComponent(name)}`, {
                  ...options,
                  headers: [{ name: "accept", value: "application/vnd.npm.install-v1+json" }],
                  timeoutMs: 60_000,
                });
                if (response.status !== 200)
                  throw new Error(`Registry responded with HTTP ${response.status}.`);
                return Schema.decodeUnknownSync(Packument)(
                  JSON.parse(new TextDecoder().decode(response.bytes)),
                );
              },
              tarball: async ({ dist, signal }) => {
                const response = await httpJsonFetch(dist.tarball, {
                  ...(signal === undefined ? {} : { signal }),
                  timeoutMs: 60_000,
                });
                if (response.status !== 200)
                  throw new Error(`Tarball responded with HTTP ${response.status}.`);
                return response.bytes;
              },
            },
          },
        }),
      ),
    ),
  );
