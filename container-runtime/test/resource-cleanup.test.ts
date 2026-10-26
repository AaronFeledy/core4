import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, ProviderId, ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { EngineHttpRequest } from "../src/engine-api.ts";
import { makeOwnedResourcesCleanup } from "../src/resource-cleanup.ts";
import { type OwnedResource, makeResourceOwnershipStore } from "../src/resource-ownership.ts";

test.each([204, 404])(
  "inventory cleanup removes anonymous volumes but retains named volumes with volumes:false (HTTP %s)",
  async (status) => {
    const root = AbsolutePath.make("/apps/owned");
    const owner = {
      appRoot: root,
      ownerKey: "owner",
      appId: AppId.make("app"),
      providerId: ProviderId.make("test"),
      identityDigest: "digest",
    };
    const container: OwnedResource = {
      ...owner,
      kind: "container",
      nativeName: "owned-container",
      service: ServiceName.make("web"),
    };
    const volume: OwnedResource = {
      ...owner,
      kind: "volume",
      nativeName: "retained-data",
      volumeClass: "data",
      volumeScope: "app",
    };
    const calls: EngineHttpRequest[] = [];
    const retired: OwnedResource[] = [];
    const cleanup = makeOwnedResourcesCleanup({
      ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
      store: {
        ...makeResourceOwnershipStore("test"),
        load: () =>
          Effect.succeed({
            appRoot: root,
            ownerKey: "owner",
            providerId: owner.providerId,
            appIds: [owner.appId],
            resources: [container, volume],
          }),
        retire: (_root, resource) =>
          Effect.sync(() => {
            retired.push(resource);
          }),
      },
      api: {
        request: (request) =>
          Effect.sync(() => {
            calls.push(request);
            return request.method === "GET"
              ? {
                  status: 200,
                  body: JSON.stringify({
                    Id: "raw/id%2F",
                    Config: {
                      Labels: {
                        "dev.lando.app": "app",
                        "dev.lando.app-root": root,
                        "dev.lando.service": "web",
                      },
                    },
                  }),
                }
              : { status, body: "" };
          }),
      },
    });
    const result = await Effect.runPromise(cleanup(root, { volumes: false }));
    expect(calls).toEqual([
      { method: "GET", path: "/containers/owned-container/json" },
      { method: "DELETE", path: "/containers/raw%2Fid%252F?force=true&v=true" },
    ]);
    expect(retired).toEqual([container]);
    expect(result).toEqual({
      servicesRemoved: status === 204 ? [container.service] : [],
      networksRemoved: 0,
      volumesRemoved: 0,
    });
  },
);

const ownershipFixture = (input: {
  readonly kind?: "container" | "volume" | "network";
  readonly labels?: Readonly<Record<string, string>>;
  readonly freshLabels?: Readonly<Record<string, string>>;
  readonly status?: number;
  readonly transport?: boolean;
  readonly missingInventory?: boolean;
}) => {
  const root = AbsolutePath.make("/apps/owned");
  const owner = {
    appRoot: root,
    ownerKey: appIdentityKey("owner", root),
    appId: AppId.make("app"),
    providerId: ProviderId.make("test"),
    identityDigest: "digest",
  };
  const resource: OwnedResource =
    input.kind === "volume"
      ? { ...owner, kind: "volume", nativeName: "data", volumeClass: "data", volumeScope: "app" }
      : input.kind === "network"
        ? { ...owner, kind: "network", nativeName: "private" }
        : { ...owner, kind: "container", nativeName: "container", service: ServiceName.make("web") };
  const labels =
    input.kind === "volume"
      ? {
          "dev.lando.app": "app",
          "dev.lando.volume-owner": root,
          "dev.lando.volume-selector": `test:app:${owner.ownerKey}:data`,
          "dev.lando.scope": "app",
          "dev.lando.volume-instance": "one",
        }
      : input.kind === "network"
        ? {
            "dev.lando.app": "app",
            "dev.lando.app-root": root,
            "dev.lando.owner": owner.ownerKey,
            "dev.lando.provider": "test",
          }
        : { "dev.lando.app": "app", "dev.lando.app-root": root, "dev.lando.service": "web" };
  const calls: EngineHttpRequest[] = [];
  const retired: OwnedResource[] = [];
  let inspections = 0;
  const cleanup = makeOwnedResourcesCleanup({
    ctx: { providerId: "test", remediation: "Retry cleanup.", env: {} },
    store: {
      ...makeResourceOwnershipStore("test"),
      load: () =>
        Effect.succeed(
          input.missingInventory ? undefined : { ...owner, appIds: [owner.appId], resources: [resource] },
        ),
      retire: (_root, resource) =>
        Effect.sync(() => {
          retired.push(resource);
        }),
    },
    api: {
      request: (request) => {
        calls.push(request);
        if (request.method === "GET") {
          inspections++;
          const observedLabels =
            inspections > 1
              ? { ...labels, ...input.labels, ...input.freshLabels }
              : { ...labels, ...input.labels };
          return Effect.succeed({
            status: 200,
            body: JSON.stringify({
              Id: "exact-id",
              Name: resource.nativeName,
              Labels: observedLabels,
              Config: { Labels: observedLabels },
            }),
          });
        }
        return input.transport
          ? Effect.fail(
              new ProviderUnavailableError({
                providerId: "test",
                operation: "delete",
                message: "unreachable",
                remediation: "Retry cleanup.",
              }),
            )
          : Effect.succeed({ status: input.status ?? 204, body: "" });
      },
    },
  });
  return { calls, retired, run: () => Effect.runPromise(Effect.result(cleanup(root, { volumes: true }))) };
};

for (const input of [
  { status: 500 },
  { transport: true },
  { labels: { "dev.lando.app-root": "/apps/same-name-other-root" } },
  { kind: "network", labels: { "dev.lando.owner": "other-owner" } },
  { kind: "volume", labels: { "dev.lando.volume-owner": "/apps/other" } },
  { kind: "volume", labels: { "dev.lando.volume-selector": "test:app:wrong:data" } },
  { kind: "volume", freshLabels: { "dev.lando.volume-instance": "two" } },
] as const) {
  test(`inventory retains unresolved ownership or deletion ${JSON.stringify(input)}`, async () => {
    const fixture = ownershipFixture(input);
    expect(await fixture.run()).toMatchObject({ _tag: "Failure" });
    expect(fixture.retired).toEqual([]);
    if ("labels" in input || "freshLabels" in input)
      expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
  });
}

test("missing ownership inventory authorizes no native discovery or deletion", async () => {
  const fixture = ownershipFixture({ missingInventory: true });
  expect(await fixture.run()).toMatchObject({
    _tag: "Success",
    success: { servicesRemoved: [], volumesRemoved: 0, networksRemoved: 0 },
  });
  expect(fixture.calls).toEqual([]);
});
