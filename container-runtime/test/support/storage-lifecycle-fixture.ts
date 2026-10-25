import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AbsolutePath, AppId, type AppPlan, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import {
  type EngineHttpApi,
  type EngineHttpRequest,
  buildContainerRemoveRequest,
} from "../../src/engine-api.ts";
import { volumeCreationFact } from "../../src/volume-creation.ts";

const createdId = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ Id: Schema.String })));
const volumeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ Name: Schema.String, Labels: Schema.Record(Schema.String, Schema.String) }),
);
const containerRequest = Schema.decodeUnknownSync(
  Schema.Struct({
    Image: Schema.String,
    HostConfig: Schema.optionalKey(Schema.Struct({ Binds: Schema.optionalKey(Schema.Array(Schema.String)) })),
  }),
);
export const storageLifecycleCommand = [
  "sh",
  "-c",
  "trap 'exit 0' TERM INT; while :; do sleep 86400 & wait $!; done",
] as const;
export const decodeStorageContainer = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      Id: Schema.String,
      Mounts: Schema.Array(
        Schema.Struct({
          Type: Schema.String,
          Name: Schema.optionalKey(Schema.String),
          Destination: Schema.String,
        }),
      ),
    }),
  ),
);

/** Only this run's successful creates enter the ledger, including partial bringUp attempts. */
export const storageLifecycleFixture = (source: EngineHttpApi, provider: "docker" | "podman") => {
  const request = source.request;
  assert.ok(request, "Storage lifecycle requires an engine request client");
  const name = `storage-${randomUUID()}`;
  const image = `localhost/${name}:fixture`;
  const retained = `${name}-retained`;
  const foreign = `${name}-foreign`;
  const borrower = `${name}-borrower`;
  const network = `${name}-network`;
  const metadata = {
    resolvedAt: DateTime.makeUnsafe("2026-10-25T00:00:00Z"),
    source: name,
    runtime: 4 as const,
  };
  const serviceName = ServiceName.make("store");
  const providerId = ProviderId.make(provider === "podman" ? "lando" : "docker");
  const plan: AppPlan = {
    valueModel: 1,
    id: AppId.make(name),
    name,
    slug: name,
    root: AbsolutePath.make(`/tmp/${name}`),
    provider: providerId,
    services: {
      [serviceName]: {
        name: serviceName,
        type: "storage-fixture",
        provider: providerId,
        primary: true,
        artifact: { kind: "ref", ref: image },
        command: storageLifecycleCommand,
        environment: {},
        mounts: [],
        storage: [{ store: retained, target: PortablePath.make("/retained"), readOnly: false }],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
    networking: { perAppBridge: { name: network, driver: "bridge" } },
    networks: [],
    routes: [],
    stores: [{ name: retained, scope: "app", kind: "data" }],
    fileSync: [],
    metadata,
    extensions: {},
  };
  // Mutable acquisition ledger: exact IDs survive replacement and assertions that fail mid-scenario.
  const containers = new Set<string>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const api: EngineHttpApi = {
    ...source,
    request: (input) =>
      Effect.suspend(() => {
        const container =
          input.method === "POST" && input.path.startsWith("/containers/create?")
            ? containerRequest(input.body)
            : undefined;
        const borrowed = container?.HostConfig?.Binds?.find((bind) => bind.split(":")[1] === "/ephemeral");
        if (borrowed !== undefined) {
          assert.ok(
            volumes.has(borrowed.split(":")[0] ?? ""),
            "Borrowed volume must already be captured by this run",
          );
        }
        return request(input).pipe(
          Effect.flatMap((response) =>
            Effect.promise(async () => {
              if (response.status < 200 || response.status >= 300 || input.method !== "POST") return response;
              if (input.path.startsWith("/containers/create?")) {
                const id = createdId(response.body).Id;
                containers.add(id);
                const inspected = await Effect.runPromise(
                  request({ method: "GET", path: `/containers/${encodeURIComponent(id)}/json` }),
                );
                assert.equal(inspected.status, 200, `Inspect newly created container ${id}`);
                for (const mount of decodeStorageContainer(inspected.body).Mounts) {
                  if (
                    container?.Image === image &&
                    borrowed === undefined &&
                    mount.Type === "volume" &&
                    mount.Destination === "/ephemeral" &&
                    mount.Name !== undefined
                  )
                    volumes.add(mount.Name);
                }
              }
              if (input.path === "/volumes/create") {
                const requested = volumeRequest(input.body);
                for (const fact of volumeCreationFact({
                  body: response.body,
                  name: requested.Name,
                  labels: requested.Labels,
                }))
                  volumes.add(fact.nativeName);
              }
              if (input.path === "/networks/create") networks.add(createdId(response.body).Id);
              return response;
            }),
          ),
        );
      }),
  };
  const call = async (input: EngineHttpRequest, accepted: readonly number[] = [200, 201, 204]) => {
    assert.ok(api.request);
    const response = await Effect.runPromise(api.request(input));
    assert.ok(
      accepted.includes(response.status),
      `${input.method} ${input.path}: HTTP ${response.status}: ${response.body}`,
    );
    return response;
  };
  return {
    api,
    call,
    plan,
    image,
    retained,
    foreign,
    borrower,
    network,
    serviceName,
    async [Symbol.asyncDispose]() {
      const failures: unknown[] = [];
      // All stages run even after a removal fails. Volumes are never force-deleted.
      const stages: readonly (readonly EngineHttpRequest[])[] = [
        [...containers].map(buildContainerRemoveRequest),
        [...volumes].map((id) => ({ method: "DELETE", path: `/volumes/${encodeURIComponent(id)}` })),
        [...networks].map((id) => ({ method: "DELETE", path: `/networks/${encodeURIComponent(id)}` })),
        [{ method: "DELETE", path: `/images/${encodeURIComponent(image)}` }],
      ];
      for (const stage of stages) {
        const results = await Promise.allSettled(stage.map((input) => call(input, [200, 204, 404])));
        for (const result of results) {
          if (result.status === "rejected") failures.push(result.reason);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, `Fixture cleanup failed for ${name}`);
    },
  };
};
